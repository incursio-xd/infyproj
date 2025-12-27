"""
YOLO Processor for Camera 2 (Local Video Processing)
Simplified version focused on video file processing with zone-based crowd analytics
"""

import cv2
import numpy as np
from ultralytics import YOLO
import sqlite3
import json
import os
import argparse
from typing import List, Dict
import time
from datetime import datetime
import socketio
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class DatabaseManager:
    """Database manager for zones and analytics"""
    
    def __init__(self, db_path: str = "auth.db"):
        self.db_path = db_path
    
    def get_connection(self):
        """Get database connection"""
        return sqlite3.connect(self.db_path)
    
    def get_zones_for_camera(self, camera_id: int) -> List[Dict]:
        """Get all zones for a specific camera"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, name, coordinates, capacity_limit, warning_threshold, alert_color
                FROM zones
                WHERE camera_id = ?
                ORDER BY created_at DESC
            """, (camera_id,))
            
            zones = []
            for row in cursor.fetchall():
                try:
                    # Parse coordinates (handle both formats)
                    coords_raw = json.loads(row[2])
                    zones.append({
                        "id": row[0],
                        "name": row[1],
                        "coordinates": coords_raw,
                        "capacity_limit": row[3] or 10,
                        "warning_threshold": row[4] or 8,
                        "alert_color": row[5] or "#4ecdc4"
                    })
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid coordinates for zone {row[0]}: {e}")
            
            return zones


class VideoProcessor:
    """Video processor with YOLO detection and zone-based counting"""
    
    def __init__(
        self,
        camera_id: int,
        model_path: str = "yolov8n.pt",
        confidence: float = 0.5,
        server_url: str = "http://localhost:7000"
    ):
        self.camera_id = camera_id
        self.model = YOLO(model_path)
        self.confidence = confidence
        self.server_url = server_url
        
        # Database
        self.db_manager = DatabaseManager()
        
        # Zones
        self.zones = {}
        self.zone_counts = {}
        
        # Statistics
        self.total_people = 0
        self.frame_times = []
        
        # Socket.IO for real-time updates
        self.socket = None
        self.setup_socket()
        
        logger.info(f"VideoProcessor initialized for Camera {camera_id}")
    
    def setup_socket(self):
        """Setup Socket.IO connection"""
        try:
            self.socket = socketio.SimpleClient()
            self.socket.connect(self.server_url, wait_timeout=10)
            logger.info(f"Connected to server at {self.server_url}")
        except Exception as e:
            logger.error(f"Failed to connect to server: {e}")
            self.socket = None
    
    def load_zones(self):
        """Load zones from database"""
        zones_data = self.db_manager.get_zones_for_camera(self.camera_id)
        
        self.zones = {}
        self.zone_counts = {}
        
        for zone in zones_data:
            zone_id = zone["id"]
            
            # Parse coordinates - handle both formats
            raw_coords = zone["coordinates"]
            coordinates = []
            
            for point in raw_coords:
                if isinstance(point, list) and len(point) >= 2:
                    # Format: [[x, y], [x, y]]
                    coordinates.append((int(point[0]), int(point[1])))
                elif isinstance(point, dict) and "x" in point and "y" in point:
                    # Format: [{x: 1, y: 2}]
                    coordinates.append((int(point["x"]), int(point["y"])))
            
            if len(coordinates) < 3:
                logger.warning(f"Zone {zone['name']} has < 3 points, skipping")
                continue
            
            self.zones[zone_id] = {
                "name": zone["name"],
                "polygon": np.array(coordinates, dtype=np.int32),
                "capacity": zone["capacity_limit"],
                "warning": zone["warning_threshold"],
                "color": zone["alert_color"]
            }
            self.zone_counts[zone_id] = 0
            
            logger.info(
                f"✓ Loaded zone '{zone['name']}': "
                f"{len(coordinates)} points, "
                f"capacity={zone['capacity_limit']}, "
                f"warning={zone['warning_threshold']}"
            )
        
        logger.info(f"Successfully loaded {len(self.zones)} zones")
        return len(self.zones) > 0
    
    def detect_people(self, frame: np.ndarray) -> List[Dict]:
        """Detect and track people in frame"""
        results = self.model.track(
            frame,
            persist=True,
            verbose=False,
            conf=self.confidence,
            classes=[0]  # Person class only
        )
        
        detections = []
        
        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue
            
            track_ids = boxes.id if boxes.id is not None else None
            
            for i, box in enumerate(boxes):
                if int(box.cls[0]) != 0:  # Not a person
                    continue
                
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                confidence = float(box.conf[0])
                
                # Get tracking ID
                if track_ids is not None:
                    track_id = int(track_ids[i])
                else:
                    track_id = i
                
                center_x = (x1 + x2) // 2
                center_y = (y1 + y2) // 2
                
                detections.append({
                    "id": track_id,
                    "bbox": [x1, y1, x2, y2],
                    "center": (center_x, center_y),
                    "confidence": confidence
                })
        
        return detections
    
    def update_zone_counts(self, detections: List[Dict]):
        """Update people count for each zone"""
        # Reset counts
        for zone_id in self.zones:
            self.zone_counts[zone_id] = 0
        
        # Count people in each zone
        for detection in detections:
            center = detection["center"]
            for zone_id, zone in self.zones.items():
                if cv2.pointPolygonTest(zone["polygon"], center, False) >= 0:
                    self.zone_counts[zone_id] += 1
        
        self.total_people = len(detections)
    
    def send_update(self, fps: float):
        """Send real-time update to server"""
        if not self.socket:
            return
        
        try:
            # Prepare zone data
            zone_counts = {}
            zones_analytics = {}
            
            for zone_id, zone in self.zones.items():
                count = self.zone_counts.get(zone_id, 0)
                zone_name = zone["name"]
                capacity = zone["capacity"]
                warning = zone["warning"]
                
                zone_counts[zone_name] = count
                
                # Calculate status
                utilization = (count / capacity * 100) if capacity > 0 else 0
                if count >= capacity:
                    status = "exceeded"
                elif count >= warning:
                    status = "warning"
                else:
                    status = "normal"
                
                zones_analytics[zone_name] = {
                    "count": count,
                    "capacity": capacity,
                    "warning_threshold": warning,
                    "utilization": utilization,
                    "status": status
                }
            
            # Send to employee dashboard
            self.socket.emit("live_camera_data", {
                "camera_id": self.camera_id,
                "total_count": self.total_people,
                "zone_counts": zone_counts,
                "fps": fps,
                "timestamp": datetime.now().isoformat()
            })
            
            # Send to analytics dashboard
            self.socket.emit("analytics_data_update", {
                "camera_id": self.camera_id,
                "timestamp": datetime.now().isoformat(),
                "total_people": self.total_people,
                "zones": zones_analytics,
                "summary": {
                    "zones_at_warning": sum(1 for z in zones_analytics.values() if z["status"] == "warning"),
                    "zones_at_capacity": sum(1 for z in zones_analytics.values() if z["status"] == "exceeded"),
                    "overall_utilization": (
                        sum(z["count"] for z in zones_analytics.values()) / 
                        sum(z["capacity"] for z in zones_analytics.values()) * 100
                    ) if zones_analytics else 0
                },
                "performance": {
                    "fps": fps,
                    "processing_time": np.mean(self.frame_times[-5:]) if self.frame_times else 0
                }
            })
            
            # Send capacity violations
            for zone_name, zone_data in zones_analytics.items():
                if zone_data["status"] in ["warning", "exceeded"]:
                    self.socket.emit("capacity_violation", {
                        "camera_id": self.camera_id,
                        "zone_name": zone_name,
                        "people_count": zone_data["count"],
                        "capacity_limit": zone_data["capacity"],
                        "violation_type": zone_data["status"],
                        "timestamp": datetime.now().isoformat()
                    })
            
        except Exception as e:
            logger.error(f"Error sending update: {e}")
    
    def draw_zones(self, frame: np.ndarray) -> np.ndarray:
        """Draw zones on frame"""
        for zone_id, zone in self.zones.items():
            count = self.zone_counts.get(zone_id, 0)
            capacity = zone["capacity"]
            
            # Determine color based on capacity
            if count >= capacity:
                color = (0, 0, 255)  # Red
            elif count >= zone["warning"]:
                color = (0, 255, 255)  # Yellow
            else:
                color = (0, 255, 0)  # Green
            
            # Draw polygon
            cv2.polylines(frame, [zone["polygon"]], True, color, 3)
            
            # Draw label
            if len(zone["polygon"]) > 0:
                x, y = zone["polygon"][0]
                label = f"{zone['name']}: {count}/{capacity}"
                
                # Background for text
                label_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)[0]
                cv2.rectangle(
                    frame,
                    (x - 5, y - label_size[1] - 10),
                    (x + label_size[0] + 5, y),
                    (0, 0, 0),
                    -1
                )
                
                # Text
                cv2.putText(
                    frame, label, (x, y - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2
                )
        
        return frame
    
    def draw_detections(self, frame: np.ndarray, detections: List[Dict]) -> np.ndarray:
        """Draw bounding boxes and IDs"""
        for det in detections:
            x1, y1, x2, y2 = det["bbox"]
            track_id = det["id"]
            
            # Bounding box
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            
            # ID label
            label = f"ID:{track_id}"
            cv2.putText(
                frame, label, (x1, y1 - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2
            )
            
            # Center point
            cv2.circle(frame, det["center"], 4, (255, 0, 0), -1)
        
        return frame
    
    def draw_stats(self, frame: np.ndarray, fps: float) -> np.ndarray:
        """Draw statistics panel"""
        h, w = frame.shape[:2]
        
        # Background panel
        panel_width = 300
        panel_x = w - panel_width - 10
        panel_y = 10
        
        stats = [
            f"Camera 2 - Video",
            f"Total People: {self.total_people}",
            f"FPS: {fps:.1f}",
            "",
            "ZONES:"
        ]
        
        for zone_id, zone in self.zones.items():
            count = self.zone_counts.get(zone_id, 0)
            capacity = zone["capacity"]
            util = (count / capacity * 100) if capacity > 0 else 0
            stats.append(f"{zone['name']}: {count}/{capacity} ({util:.0f}%)")
        
        # Draw panel
        panel_height = len(stats) * 25 + 20
        cv2.rectangle(
            frame,
            (panel_x, panel_y),
            (w - 10, panel_y + panel_height),
            (0, 0, 0),
            -1
        )
        cv2.rectangle(
            frame,
            (panel_x, panel_y),
            (w - 10, panel_y + panel_height),
            (100, 100, 100),
            2
        )
        
        # Draw text
        for i, stat in enumerate(stats):
            y_pos = panel_y + 20 + i * 25
            cv2.putText(
                frame, stat, (panel_x + 10, y_pos),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2
            )
        
        return frame
    
    def process_video(self, video_path: str, show_video: bool = True):
        """Process video file"""
        cap = cv2.VideoCapture(video_path)
        
        if not cap.isOpened():
            logger.error(f"Cannot open video: {video_path}")
            return
        
        fps = int(cap.get(cv2.CAP_PROP_FPS))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        logger.info(f"Video: {width}x{height} @ {fps}fps, {total_frames} frames")
        
        frame_count = 0
        start_time = time.time()
        
        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                
                frame_start = time.time()
                
                # Detect people
                detections = self.detect_people(frame)
                
                # Update zone counts
                self.update_zone_counts(detections)
                
                # Calculate FPS
                elapsed = time.time() - start_time
                current_fps = frame_count / elapsed if elapsed > 0 else 0
                
                # Draw visualizations
                frame = self.draw_zones(frame)
                frame = self.draw_detections(frame, detections)
                frame = self.draw_stats(frame, current_fps)
                
                # Send updates every second
                if frame_count % fps == 0:
                    self.send_update(current_fps)
                
                # Show frame
                if show_video:
                    cv2.imshow(f"Camera {self.camera_id} - YOLO Processing", frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break
                
                # Track timing
                frame_time = time.time() - frame_start
                self.frame_times.append(frame_time)
                if len(self.frame_times) > 100:
                    self.frame_times.pop(0)
                
                frame_count += 1
                
                # Log progress
                if frame_count % 30 == 0:
                    logger.info(
                        f"Frame {frame_count}/{total_frames}: "
                        f"{self.total_people} people, {current_fps:.1f} FPS"
                    )
        
        except KeyboardInterrupt:
            logger.info("Processing interrupted")
        
        finally:
            cap.release()
            cv2.destroyAllWindows()
            
            if self.socket:
                self.socket.disconnect()
            
            elapsed = time.time() - start_time
            logger.info(f"Processing complete: {frame_count} frames in {elapsed:.1f}s")
            logger.info(f"Average FPS: {frame_count / elapsed:.1f}")


def main():
    parser = argparse.ArgumentParser(description="YOLO Video Processor for Camera 2")
    parser.add_argument("--video", type=str, required=True, help="Path to video file")
    parser.add_argument("--camera-id", type=int, default=2, help="Camera ID")
    parser.add_argument("--model", type=str, default="yolov8n.pt", help="YOLO model")
    parser.add_argument("--conf", type=float, default=0.5, help="Confidence threshold")
    parser.add_argument("--db-url", type=str, default="http://localhost:7000", help="Server URL")
    parser.add_argument("--headless", action="store_true", help="No display")
    
    args = parser.parse_args()
    
    # Check video exists
    if not os.path.exists(args.video):
        logger.error(f"Video not found: {args.video}")
        return
    
    logger.info(f"Processing video: {os.path.basename(args.video)}")
    logger.info(f"Camera ID: {args.camera_id}")
    
    # Initialize processor
    processor = VideoProcessor(
        camera_id=args.camera_id,
        model_path=args.model,
        confidence=args.conf,
        server_url=args.db_url
    )
    
    # Load zones
    if not processor.load_zones():
        logger.error("No zones found. Please create zones first.")
        return
    
    # Process video
    processor.process_video(args.video, show_video=not args.headless)


if __name__ == "__main__":
    main()