import cv2
import numpy as np
from ultralytics import YOLO
import sqlite3
import json
import os
import argparse
from typing import List, Tuple, Dict, Set, Optional
import time
from datetime import datetime, timedelta
import socketio
import threading
import logging


logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class AnalyticsManager:
    """Enhanced analytics manager for capacity monitoring and historical data"""

    def __init__(self, db_path: str = "auth.db"):
        self.db_path = db_path
        self.capacity_violations = {}  

    def get_connection(self):
        """Get database connection"""
        return sqlite3.connect(self.db_path)

    def save_analytics_data(
        self,
        camera_id: int,
        zone_id: int,
        people_count: int,
        capacity_limit: int,
        timestamp: datetime = None,
    ):
        """Save analytics data point"""
        if timestamp is None:
            timestamp = datetime.now()

        capacity_utilization = (
            (people_count / capacity_limit) * 100 if capacity_limit > 0 else 0
        )

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO zone_analytics 
                (zone_id, camera_id, people_count, capacity_utilization, timestamp)
                VALUES (?, ?, ?, ?, ?)
            """,
                (zone_id, camera_id, people_count, capacity_utilization, timestamp),
            )
            conn.commit()

    def check_capacity_violation(
        self,
        zone_id: int,
        zone_name: str,
        people_count: int,
        capacity_limit: int,
        warning_threshold: int,
        camera_id: int,
    ) -> Dict:
        """Check for capacity violations and manage violation states"""
        current_time = datetime.now()
        violation_info = None

        utilization_percent = (
            (people_count / capacity_limit) * 100 if capacity_limit > 0 else 0
        )

        # Determine violation type
        violation_type = None
        if people_count >= capacity_limit:
            violation_type = "exceeded"
        elif people_count >= warning_threshold:
            violation_type = "warning"

        # Handle violation start/end
        violation_key = f"{zone_id}_{violation_type}" if violation_type else None

        if violation_type:
            # Start or continue violation
            if violation_key not in self.capacity_violations:
                # New violation - log it
                violation_info = self._log_violation_start(
                    zone_id,
                    camera_id,
                    zone_name,
                    people_count,
                    capacity_limit,
                    violation_type,
                    current_time,
                )
                self.capacity_violations[violation_key] = {
                    "start_time": current_time,
                    "violation_id": violation_info["id"],
                }
                logger.warning(
                    f"Capacity {violation_type} started for zone {zone_name}: {people_count}/{capacity_limit}"
                )
            else:
                # Ongoing violation
                violation_info = {
                    "zone_id": zone_id,
                    "camera_id": camera_id,  # Include camera_id
                    "zone_name": zone_name,
                    "people_count": people_count,
                    "capacity_limit": capacity_limit,
                    "violation_type": violation_type,
                    "type": violation_type,  # For compatibility
                    "timestamp": current_time.isoformat(),
                    "ongoing": True,
                }

        else:
            # Check if we need to end any violations for this zone
            keys_to_remove = []
            for key in self.capacity_violations:
                if key.startswith(f"{zone_id}_"):
                    violation_data = self.capacity_violations[key]
                    self._log_violation_end(
                        violation_data["violation_id"], current_time
                    )
                    keys_to_remove.append(key)
                    logger.info(f"Capacity violation resolved for zone {zone_name}")

            for key in keys_to_remove:
                del self.capacity_violations[key]

        return violation_info

    def _log_violation_start(
        self,
        zone_id: int,
        camera_id: int,
        zone_name: str,
        people_count: int,
        capacity_limit: int,
        violation_type: str,
        start_time: datetime,
    ) -> Dict:
        """Log the start of a capacity violation"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO capacity_violations 
                (zone_id, camera_id, zone_name, people_count, capacity_limit, 
                 violation_type, violation_start)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    zone_id,
                    camera_id,
                    zone_name,
                    people_count,
                    capacity_limit,
                    violation_type,
                    start_time,
                ),
            )

            violation_id = cursor.lastrowid
            conn.commit()

            return {
                "id": violation_id,
                "zone_id": zone_id,
                "camera_id": camera_id,
                "zone_name": zone_name,
                "people_count": people_count,
                "capacity_limit": capacity_limit,
                "violation_type": violation_type,
                "violation_start": start_time,
                "timestamp": start_time.isoformat(),
                "type": violation_type,
                "ongoing": False,
            }

    def _log_violation_end(self, violation_id: int, end_time: datetime):
        """Log the end of a capacity violation"""
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # Get violation start time to calculate duration
            cursor.execute(
                """
                SELECT violation_start FROM capacity_violations WHERE id = ?
            """,
                (violation_id,),
            )
            result = cursor.fetchone()

            if result:
                start_time = datetime.fromisoformat(result[0])
                duration = int((end_time - start_time).total_seconds())

                cursor.execute(
                    """
                    UPDATE capacity_violations 
                    SET violation_end = ?, duration_seconds = ?
                    WHERE id = ?
                """,
                    (end_time, duration, violation_id),
                )
                conn.commit()

    def save_hourly_summary(
        self,
        camera_id: int,
        total_people: int,
        zones_at_capacity: int,
        zones_at_warning: int,
        peak_occupancy: int,
        avg_occupancy: float,
    ):
        """Save hourly analytics summary"""
        current_time = datetime.now()
        hour_of_day = current_time.hour
        date_recorded = current_time.date()

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT OR REPLACE INTO analytics_summary 
                (camera_id, total_people, zones_at_capacity, zones_at_warning, 
                 peak_occupancy, avg_occupancy, hour_of_day, date_recorded, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    camera_id,
                    total_people,
                    zones_at_capacity,
                    zones_at_warning,
                    peak_occupancy,
                    avg_occupancy,
                    hour_of_day,
                    date_recorded,
                    current_time,
                ),
            )
            conn.commit()


class DatabaseManager:
    """Enhanced database manager with capacity and analytics support"""

    def __init__(self, db_path: str = "auth.db"):
        self.db_path = db_path

    def get_connection(self):
        """Get database connection"""
        return sqlite3.connect(self.db_path)

    def get_zones_with_capacity(self, camera_id: int) -> List[Dict]:
        """Get all zones for a camera with capacity information"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, name, coordinates, user_id, created_at,
                       capacity_limit, warning_threshold, alert_color
                FROM zones
                WHERE camera_id = ?
                ORDER BY created_at DESC
            """,
                (camera_id,),
            )

            zones = []
            for row in cursor.fetchall():
                try:
                    coordinates = json.loads(row[2])
                    zones.append(
                        {
                            "id": row[0],
                            "name": row[1],
                            "coordinates": coordinates,
                            "user_id": row[3],
                            "created_at": row[4],
                            "capacity_limit": row[5] or 50,  # Default capacity
                            "warning_threshold": row[6] or 40,  # Default warning
                            "alert_color": row[7] or "#4ecdc4",
                        }
                    )
                except json.JSONDecodeError:
                    logger.error(f"Invalid coordinates format for zone {row[0]}")

            return zones

    def get_current_video(self) -> Optional[Dict]:
        """Get the currently selected video from database"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT v.id, v.original_name, v.filename, v.path, v.user_id, u.username
                FROM videos v
                JOIN users u ON v.user_id = u.id
                WHERE v.is_current = 1
                LIMIT 1
            """
            )
            result = cursor.fetchone()

            if result:
                return {
                    "id": result[0],
                    "original_name": result[1],
                    "filename": result[2],
                    "path": result[3],
                    "user_id": result[4],
                    "username": result[5],
                }
            return None


class EnhancedPersonTracker:
    """Enhanced person tracker with capacity management and analytics"""

    def __init__(
        self,
        model_path: str = "yolov8n.pt",
        confidence_threshold: float = 0.5,
        db_manager: DatabaseManager = None,
        analytics_manager: AnalyticsManager = None,
        camera_id: int = 1,
        enable_realtime: bool = True,
        server_url: str = "http://localhost:7000",
    ):
        """
        Initialize the enhanced person tracker

        Args:
            model_path: Path to YOLOv8 model
            confidence_threshold: Minimum confidence for detections
            db_manager: Database manager instance
            analytics_manager: Analytics manager instance
            camera_id: Camera identifier for real-time updates
            enable_realtime: Enable Socket.IO real-time updates
        """
        self.model = YOLO(model_path)
        self.confidence_threshold = confidence_threshold
        self.db_manager = db_manager or DatabaseManager()
        self.analytics_manager = analytics_manager or AnalyticsManager()
        self.camera_id = camera_id
        self.server_url = server_url

        # Zone management with capacity
        self.zones = {}  # Dict to store zones with capacity info
        self.zone_counts = {}  # Current count for each zone
        self.people_in_zones = {}  # Track which people are in which zones

        # Tracking data
        self.total_detections = 0
        self.active_tracks = 0
        self.frame_processing_times = []

        # Analytics data
        self.hourly_counts = []
        self.last_analytics_save = time.time()
        self.analytics_save_interval = 30  # Save every 30 seconds

        # Capacity monitoring
        self.capacity_alerts_sent = set()
        self.last_violation_check = time.time()

        # Real-time communication
        self.enable_realtime = enable_realtime
        self.socket_client = None
        if enable_realtime:
            self.setup_socket_client()

        # Update tracking
        self.last_update_time = time.time()
        self.update_interval = 1.0  # Send updates every 1 second

        logger.info(f"Enhanced PersonTracker initialized for Camera {camera_id}")

    def setup_socket_client(self):
        """Setup Socket.IO client for real-time communication"""
        try:
            self.socket_client = socketio.SimpleClient()
            self.socket_client.connect(self.server_url, wait_timeout=10)
            logger.info(
                f"Connected to Socket.IO server at {self.server_url} for Camera {self.camera_id}"
            )

            # Send initial connection confirmation
            self.socket_client.emit(
                "camera_connected", {"camera_id": self.camera_id, "status": "connected"}
            )

        except Exception as e:
            logger.error(
                f"Failed to connect to Socket.IO server at {self.server_url}: {e}"
            )
            self.socket_client = None
            self.enable_realtime = False

    def load_zones_with_capacity(self, camera_id: int):
        """Load zones from database with capacity information"""
        zones = self.db_manager.get_zones_with_capacity(camera_id)

        self.zones = {}
        self.zone_counts = {}
        self.people_in_zones = {}

        for zone in zones:
            zone_id = zone["id"]
            # Convert coordinates to numpy array
            coordinates = [(point["x"], point["y"]) for point in zone["coordinates"]]

            self.zones[zone_id] = {
                "name": zone["name"],
                "polygon": np.array(coordinates, dtype=np.int32),
                "user_id": zone["user_id"],
                "capacity_limit": zone["capacity_limit"],
                "warning_threshold": zone["warning_threshold"],
                "alert_color": zone["alert_color"],
            }
            self.zone_counts[zone_id] = 0
            self.people_in_zones[zone_id] = set()

        logger.info(
            f"Loaded {len(self.zones)} zones with capacity info for camera {camera_id}"
        )
        for zone_id, zone in self.zones.items():
            logger.info(
                f"Zone '{zone['name']}': capacity={zone['capacity_limit']}, warning={zone['warning_threshold']}"
            )

    def detect_and_track(self, frame: np.ndarray) -> List[Dict]:
        """
        Detect and track persons in the frame using YOLOv8 with ByteTrack
        """
        start_time = time.time()

        # Use YOLOv8's built-in tracking
        results = self.model.track(frame, persist=True, verbose=False, stream=True)
        tracked_objects = []

        for result in results:
            boxes = result.boxes
            if boxes is not None:
                track_ids = boxes.id if boxes.id is not None else None

                for i, box in enumerate(boxes):
                    cls_id = int(box.cls[0])
                    if (
                        self.model.names[cls_id] == "person"
                        and float(box.conf[0]) >= self.confidence_threshold
                    ):
                        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                        confidence = float(box.conf[0])

                        if track_ids is not None:
                            final_track_id = int(track_ids[i])
                        else:
                            final_track_id = hash(f"{x1}_{y1}_{x2}_{y2}") % 10000

                        center_x = int((x1 + x2) / 2)
                        center_y = int((y1 + y2) / 2)

                        tracked_objects.append(
                            {
                                "id": final_track_id,
                                "bbox": [x1, y1, x2, y2],
                                "confidence": confidence,
                                "center": (center_x, center_y),
                            }
                        )

        # Update tracking statistics
        self.total_detections = len(tracked_objects)
        self.active_tracks = len(set(obj["id"] for obj in tracked_objects))

        processing_time = time.time() - start_time
        self.frame_processing_times.append(processing_time)

        if len(self.frame_processing_times) > 100:
            self.frame_processing_times = self.frame_processing_times[-50:]

        return tracked_objects

    def is_point_in_polygon(self, point: Tuple[int, int], polygon: np.ndarray) -> bool:
        """Check if a point is inside a polygon"""
        return cv2.pointPolygonTest(polygon, point, False) >= 0

    def update_zone_counts_with_capacity(self, tracked_objects: List[Dict]):
        """Update zone counts and check capacity violations"""
        # Reset current counts
        for zone_id in self.zones:
            self.people_in_zones[zone_id] = set()

        # Check each tracked person against all zones
        for obj in tracked_objects:
            for zone_id, zone_data in self.zones.items():
                if self.is_point_in_polygon(obj["center"], zone_data["polygon"]):
                    self.people_in_zones[zone_id].add(obj["id"])

        # Update counts and check for violations
        current_time = time.time()
        violations_detected = []

        for zone_id in self.zones:
            new_count = len(self.people_in_zones[zone_id])
            previous_count = self.zone_counts.get(zone_id, 0)
            self.zone_counts[zone_id] = new_count

            # Save analytics data periodically
            if current_time - self.last_analytics_save > self.analytics_save_interval:
                self.analytics_manager.save_analytics_data(
                    self.camera_id,
                    zone_id,
                    new_count,
                    self.zones[zone_id]["capacity_limit"],
                )

            # Check for capacity violations
            violation = self.analytics_manager.check_capacity_violation(
                zone_id,
                self.zones[zone_id]["name"],
                new_count,
                self.zones[zone_id]["capacity_limit"],
                self.zones[zone_id]["warning_threshold"],
                self.camera_id,
            )

            if violation and not violation.get("ongoing", False):
                # Only send alert for new violations, not ongoing ones
                violations_detected.append(violation)

        # Update analytics save time
        if current_time - self.last_analytics_save > self.analytics_save_interval:
            self.last_analytics_save = current_time

        # Send real-time updates
        self.send_enhanced_analytics_data()

        # Send violation alerts
        for violation in violations_detected:
            self.send_capacity_violation_alert(violation)

    def send_enhanced_analytics_data(self, fps: float = 0):
        """Send comprehensive analytics data for both employee and analytics dashboards"""
        if not self.enable_realtime or not self.socket_client:
            return

        current_time = time.time()
        if current_time - self.last_update_time < self.update_interval:
            return

        # Prepare zone data with full analytics info
        zones_analytics = {}
        zones_at_warning = 0
        zones_at_capacity = 0
        capacity_violations = []

        for zone_id, count in self.zone_counts.items():
            if zone_id in self.zones:
                zone_info = self.zones[zone_id]
                zone_name = zone_info["name"]
                capacity = zone_info["capacity_limit"]
                warning = zone_info["warning_threshold"]

                utilization = (count / capacity * 100) if capacity > 0 else 0

                # Determine status
                if count >= capacity:
                    status = "exceeded"
                    zones_at_capacity += 1
                elif count >= warning:
                    status = "warning"
                    zones_at_warning += 1
                else:
                    status = "normal"

                zones_analytics[zone_name] = {
                    "count": count,
                    "capacity": capacity,
                    "warning_threshold": warning,
                    "utilization": utilization,
                    "status": status,
                    "zone_id": zone_id,
                }

                # Check for violations to report
                if status != "normal":
                    capacity_violations.append(
                        {
                            "zone_id": zone_id,
                            "zone_name": zone_name,
                            "people_count": count,
                            "capacity_limit": capacity,
                            "violation_type": status,
                            "timestamp": datetime.now().isoformat(),
                        }
                    )

        # Comprehensive update data for employee dashboard
        employee_update = {
            "camera_id": self.camera_id,
            "total_count": self.total_detections,
            "active_tracks": self.active_tracks,
            "zone_counts": {
                name: data["count"] for name, data in zones_analytics.items()
            },
            "zone_capacity_info": zones_analytics,
            "zones_at_warning": zones_at_warning,
            "zones_at_capacity": zones_at_capacity,
            "processing_time": (
                np.mean(self.frame_processing_times[-5:])
                if self.frame_processing_times
                else 0
            ),
            "fps": fps,
            "timestamp": datetime.now().isoformat(),
        }

        # Analytics dashboard specific data
        analytics_update = {
            "camera_id": self.camera_id,
            "timestamp": datetime.now().isoformat(),
            "total_people": self.total_detections,
            "zones": zones_analytics,
            "summary": {
                "total_capacity": sum(
                    zone["capacity"] for zone in zones_analytics.values()
                ),
                "total_occupancy": sum(
                    zone["count"] for zone in zones_analytics.values()
                ),
                "zones_at_warning": zones_at_warning,
                "zones_at_capacity": zones_at_capacity,
                "overall_utilization": (
                    (
                        sum(zone["count"] for zone in zones_analytics.values())
                        / sum(zone["capacity"] for zone in zones_analytics.values())
                        * 100
                    )
                    if zones_analytics
                    else 0
                ),
            },
            "performance": {
                "fps": fps,
                "processing_time": (
                    np.mean(self.frame_processing_times[-5:])
                    if self.frame_processing_times
                    else 0
                ),
            },
        }

        try:
            # Send to employee dashboard
            self.socket_client.emit("live_camera_data", employee_update)

            # Send to analytics dashboard
            self.socket_client.emit("analytics_data_update", analytics_update)

            # Send capacity violations if any
            for violation in capacity_violations:
                self.socket_client.emit("capacity_violation", violation)

            logger.debug(
                f"Sent analytics data for Camera {self.camera_id}: {self.total_detections} people, "
                f"warnings: {zones_at_warning}, exceeded: {zones_at_capacity}"
            )

            self.last_update_time = current_time

        except Exception as e:
            logger.error(f"Error sending analytics data: {e}")

    def send_capacity_violation_alert(self, violation: Dict):
        """Send capacity violation alert via socket"""
        if not self.enable_realtime or not self.socket_client or not violation:
            return

        try:
            violation_with_camera = {
                "zone_id": violation.get("zone_id"),
                "camera_id": self.camera_id,  # Always include camera_id
                "zone_name": violation.get("zone_name"),
                "people_count": violation.get("people_count"),
                "capacity_limit": violation.get("capacity_limit"),
                "violation_type": violation.get("violation_type")
                or violation.get("type"),  # Handle both field names
                "timestamp": violation.get("violation_start")
                or violation.get("timestamp")
                or datetime.now().isoformat(),
                "ongoing": violation.get("ongoing", False),
            }
            violation_with_camera = violation.copy()
            violation_with_camera["camera_id"] = self.camera_id
            self.socket_client.emit("capacity_violation", violation)
            logger.warning(
                f"Sent capacity violation alert: {violation['zone_name']} - {violation['violation_type']}"
            )
        except Exception as e:
            logger.error(f"Error sending capacity violation alert: {e}")
            logger.error(f"Violation data: {violation}")

    def draw_zones_with_capacity_info(self, frame: np.ndarray) -> np.ndarray:
        """Draw zones with capacity status visualization"""
        zone_colors = {
            "normal": (0, 255, 0),  # Green
            "warning": (0, 255, 255),  # Yellow
            "exceeded": (0, 0, 255),  # Red
        }

        for zone_id, zone_data in self.zones.items():
            polygon = zone_data["polygon"]
            zone_name = zone_data["name"]
            count = self.zone_counts.get(zone_id, 0)
            capacity = zone_data["capacity_limit"]
            warning = zone_data["warning_threshold"]

            # Determine status and color
            if count >= capacity:
                status = "exceeded"
            elif count >= warning:
                status = "warning"
            else:
                status = "normal"

            color = zone_colors[status]

            # Draw polygon with status-based styling
            line_thickness = (
                4 if status == "exceeded" else 3 if status == "warning" else 2
            )
            cv2.polylines(frame, [polygon], True, color, line_thickness)

            # Fill with semi-transparent color for exceeded zones
            if status == "exceeded":
                overlay = frame.copy()
                cv2.fillPoly(overlay, [polygon], color)
                cv2.addWeighted(frame, 0.8, overlay, 0.2, 0, frame)

            # Draw zone label with capacity info
            if len(polygon) > 0:
                x, y = polygon[0]

                # Main label
                utilization = (count / capacity * 100) if capacity > 0 else 0
                label_text = f"{zone_name}: {count}/{capacity}"

                # Status indicator
                status_text = f"{utilization:.0f}% - {status.upper()}"

                # Draw label background
                label_size = cv2.getTextSize(
                    label_text, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2
                )[0]
                status_size = cv2.getTextSize(
                    status_text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 2
                )[0]

                max_width = max(label_size[0], status_size[0])
                bg_height = label_size[1] + status_size[1] + 15

                cv2.rectangle(
                    frame,
                    (x - 5, y - bg_height - 5),
                    (x + max_width + 10, y + 5),
                    (0, 0, 0),
                    -1,
                )
                cv2.rectangle(
                    frame,
                    (x - 5, y - bg_height - 5),
                    (x + max_width + 10, y + 5),
                    color,
                    2,
                )

                # Draw text
                cv2.putText(
                    frame,
                    label_text,
                    (x, y - status_size[1] - 5),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    color,
                    2,
                )
                cv2.putText(
                    frame, status_text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2
                )

        return frame

    def draw_detections(
        self, frame: np.ndarray, tracked_objects: List[Dict]
    ) -> np.ndarray:
        """Draw detection bounding boxes and tracking IDs on the frame"""
        for obj in tracked_objects:
            x1, y1, x2, y2 = obj["bbox"]
            track_id = obj["id"]
            confidence = obj["confidence"]

            # Draw bounding box
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)

            # Draw tracking ID and confidence
            label = f"ID:{track_id} ({confidence:.2f})"
            label_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)[0]

            # Background rectangle for label
            cv2.rectangle(
                frame,
                (x1, y1 - label_size[1] - 10),
                (x1 + label_size[0], y1),
                (0, 255, 0),
                -1,
            )

            # Label text
            cv2.putText(
                frame, label, (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2
            )

            # Draw center point
            center_x, center_y = obj["center"]
            cv2.circle(frame, (center_x, center_y), 4, (255, 0, 0), -1)

        return frame

    def draw_enhanced_statistics(
        self, frame: np.ndarray, fps: float, tracked_objects: List[Dict]
    ) -> np.ndarray:
        """Draw enhanced statistics with capacity information"""
        height, width = frame.shape[:2]

        # Calculate statistics
        avg_processing_time = (
            np.mean(self.frame_processing_times[-30:])
            if self.frame_processing_times
            else 0
        )

        # Calculate capacity statistics
        total_capacity = sum(zone["capacity_limit"] for zone in self.zones.values())
        total_occupancy = sum(self.zone_counts.values())
        overall_utilization = (
            (total_occupancy / total_capacity * 100) if total_capacity > 0 else 0
        )

        zones_at_warning = sum(
            1
            for zone_id, count in self.zone_counts.items()
            if count >= self.zones[zone_id]["warning_threshold"]
        )
        zones_at_capacity = sum(
            1
            for zone_id, count in self.zone_counts.items()
            if count >= self.zones[zone_id]["capacity_limit"]
        )

        # Statistics panels
        stats_sections = [
            {
                "title": "PEOPLE COUNT",
                "items": [
                    f"Total People: {self.total_detections}",
                    f"Active Tracks: {self.active_tracks}",
                    f"Processing: {avg_processing_time*1000:.1f}ms",
                    f"FPS: {fps:.1f}",
                ],
            },
            {
                "title": "CAPACITY STATUS",
                "items": [
                    f"Total Capacity: {total_capacity}",
                    f"Occupancy: {total_occupancy}",
                    f"Utilization: {overall_utilization:.1f}%",
                    f"Zones at Risk: {zones_at_warning + zones_at_capacity}",
                ],
            },
            {"title": "ZONE BREAKDOWN", "items": []},
        ]

        # Add zone-specific info
        for zone_id, zone_data in self.zones.items():
            count = self.zone_counts.get(zone_id, 0)
            capacity = zone_data["capacity_limit"]
            utilization = (count / capacity * 100) if capacity > 0 else 0
            status = "⚠️" if count >= zone_data["warning_threshold"] else "✅"
            if count >= capacity:
                status = "🚨"

            stats_sections[2]["items"].append(
                f'{status} {zone_data["name"]}: {count}/{capacity} ({utilization:.0f}%)'
            )

        # Draw statistics panel
        panel_width = 350
        panel_x = width - panel_width - 10
        panel_y = 10

        current_y = panel_y

        for section in stats_sections:
            section_height = len(section["items"]) * 25 + 40

            # Section background
            cv2.rectangle(
                frame,
                (panel_x, current_y),
                (width - 10, current_y + section_height),
                (0, 0, 0),
                -1,
            )
            cv2.rectangle(
                frame,
                (panel_x, current_y),
                (width - 10, current_y + section_height),
                (100, 100, 100),
                2,
            )

            # Section title
            cv2.putText(
                frame,
                section["title"],
                (panel_x + 10, current_y + 25),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 255),
                2,
            )

            # Section items
            for i, item in enumerate(section["items"]):
                y_pos = current_y + 50 + i * 25
                color = (255, 255, 255)

                # Color coding for capacity items
                if (
                    "Zones at Risk:" in item
                    and zones_at_warning + zones_at_capacity > 0
                ):
                    color = (0, 0, 255)
                elif "Utilization:" in item and overall_utilization >= 80:
                    color = (0, 255, 255)
                elif "🚨" in item:
                    color = (0, 0, 255)
                elif "⚠️" in item:
                    color = (0, 255, 255)
                elif "✅" in item:
                    color = (0, 255, 0)

                cv2.putText(
                    frame,
                    item,
                    (panel_x + 10, y_pos),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    color,
                    2,
                )

            current_y += section_height + 10

        # Overall status indicator
        status_text = "NORMAL"
        status_color = (0, 255, 0)

        if zones_at_capacity > 0:
            status_text = f"CRITICAL - {zones_at_capacity} ZONES EXCEEDED"
            status_color = (0, 0, 255)
        elif zones_at_warning > 0:
            status_text = f"WARNING - {zones_at_warning} ZONES AT RISK"
            status_color = (0, 255, 255)

        # Status bar at bottom
        status_bg_height = 40
        cv2.rectangle(
            frame, (0, height - status_bg_height), (width, height), (0, 0, 0), -1
        )
        cv2.rectangle(
            frame, (0, height - status_bg_height), (width, height), status_color, 3
        )

        cv2.putText(
            frame,
            status_text,
            (20, height - 15),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            status_color,
            2,
        )

        # Timestamp
        timestamp_text = f"Updated: {datetime.now().strftime('%H:%M:%S')}"
        cv2.putText(
            frame,
            timestamp_text,
            (width - 200, height - 15),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (255, 255, 255),
            2,
        )

        return frame

    def cleanup(self):
        """Enhanced cleanup with analytics saving"""
        # Save final analytics summary
        if self.zones:
            zones_at_capacity = sum(
                1
                for zone_id, count in self.zone_counts.items()
                if count >= self.zones[zone_id]["capacity_limit"]
            )
            zones_at_warning = sum(
                1
                for zone_id, count in self.zone_counts.items()
                if count >= self.zones[zone_id]["warning_threshold"]
            )

            peak_occupancy = (
                max(self.hourly_counts) if self.hourly_counts else self.total_detections
            )
            avg_occupancy = (
                np.mean(self.hourly_counts)
                if self.hourly_counts
                else self.total_detections
            )

            self.analytics_manager.save_hourly_summary(
                self.camera_id,
                self.total_detections,
                zones_at_capacity,
                zones_at_warning,
                peak_occupancy,
                avg_occupancy,
            )

        if self.socket_client:
            try:
                self.socket_client.emit(
                    "camera_processing_status",
                    {
                        "cameraId": self.camera_id,
                        "status": "stopped",
                        "message": f"Camera {self.camera_id} processing stopped",
                    },
                )
                self.socket_client.disconnect()
                logger.info(
                    f"Disconnected from Socket.IO server for Camera {self.camera_id}"
                )
            except Exception as e:
                logger.error(f"Error during cleanup: {e}")


def main():
    """Enhanced main function with analytics and capacity management"""

    parser = argparse.ArgumentParser(
        description="Enhanced Person Detection with Capacity Management"
    )
    parser.add_argument("--video-id", type=int, help="Video ID from database")
    parser.add_argument("--video", type=str, help="Direct path to video file")
    parser.add_argument(
        "--camera-id", type=int, default=1, help="Camera ID for zone loading"
    )
    parser.add_argument(
        "--model", type=str, default="yolov8n.pt", help="Path to YOLOv8 model"
    )
    parser.add_argument("--conf", type=float, default=0.5, help="Confidence threshold")
    parser.add_argument("--output", type=str, help="Path to save output video")
    parser.add_argument(
        "--save-interval", type=int, default=30, help="Save data to DB every N frames"
    )
    parser.add_argument(
        "--no-realtime", action="store_true", help="Disable real-time updates"
    )
    parser.add_argument("--headless", action="store_true", help="Run without display")
    parser.add_argument(
        "--db-url", type=str, help="Database/Server URL for Socket.IO connection"
    )

    args = parser.parse_args()

    # Initialize managers
    db_manager = DatabaseManager()
    analytics_manager = AnalyticsManager()

    # Get video information
    if args.video:
        video_path = args.video
        video_info = {"original_name": os.path.basename(video_path)}
    else:
        video_info = db_manager.get_current_video()
        if not video_info:
            logger.error("No current video found in database")
            return
        video_path = os.path.join("uploads", video_info["filename"])

    if not os.path.exists(video_path):
        logger.error(f"Video file not found: {video_path}")
        return

    logger.info(f"Processing video: {video_info['original_name']}")
    logger.info(f"Camera ID: {args.camera_id}")

    # Initialize enhanced tracker
    server_url = args.db_url or "http://localhost:7000"
    tracker = EnhancedPersonTracker(
        model_path=args.model,
        confidence_threshold=args.conf,
        db_manager=db_manager,
        analytics_manager=analytics_manager,
        camera_id=args.camera_id,
        enable_realtime=not args.no_realtime,
        server_url=server_url,
    )

    # Load zones with capacity information
    tracker.load_zones_with_capacity(args.camera_id)

    if not tracker.zones:
        logger.warning(f"No zones found for camera {args.camera_id}")
        return

    # Open video
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        logger.error(f"Could not open video: {video_path}")
        return

    fps = int(cap.get(cv2.CAP_PROP_FPS))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    logger.info(f"Video: {width}x{height} at {fps} FPS, {total_frames} frames")

    # Setup output video writer
    out = None
    if args.output:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(args.output, fourcc, fps, (width, height))

    frame_count = 0
    start_time = time.time()

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            frame_count += 1

            # Process frame
            tracked_objects = tracker.detect_and_track(frame)

            # Update zone counts with capacity checking
            tracker.update_zone_counts_with_capacity(tracked_objects)

            # Store hourly data for analytics
            if frame_count % (fps * 60) == 0:  # Every minute
                tracker.hourly_counts.append(len(tracked_objects))
                if len(tracker.hourly_counts) > 60:  # Keep last hour
                    tracker.hourly_counts.pop(0)

            # Draw enhanced visualizations
            frame = tracker.draw_zones_with_capacity_info(frame)
            frame = tracker.draw_detections(frame, tracked_objects)

            # Calculate current FPS
            elapsed_time = time.time() - start_time
            current_fps = frame_count / elapsed_time if elapsed_time > 0 else 0

            frame = tracker.draw_enhanced_statistics(
                frame, current_fps, tracked_objects
            )

            # Display frame
            if not args.headless:
                cv2.imshow(f"Enhanced Crowd Analytics - Camera {args.camera_id}", frame)

                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break

            # Save output frame
            if out:
                out.write(frame)

            # Periodic logging
            if frame_count % args.save_interval == 0:
                logger.info(
                    f"Frame {frame_count}/{total_frames}: {len(tracked_objects)} people, "
                    f"FPS: {current_fps:.1f}"
                )

                # Log capacity status
                for zone_id, zone_data in tracker.zones.items():
                    count = tracker.zone_counts.get(zone_id, 0)
                    capacity = zone_data["capacity_limit"]
                    utilization = (count / capacity * 100) if capacity > 0 else 0

                    if utilization >= 80:
                        logger.warning(
                            f"Zone '{zone_data['name']}' at {utilization:.0f}% capacity ({count}/{capacity})"
                        )

    except KeyboardInterrupt:
        logger.info("Processing interrupted by user")

    finally:
        # Cleanup
        elapsed_time = time.time() - start_time
        final_fps = frame_count / elapsed_time if elapsed_time > 0 else 0

        tracker.cleanup()
        cap.release()
        if out:
            out.release()
        cv2.destroyAllWindows()

        logger.info(f"Processing completed:")
        logger.info(f"- Frames processed: {frame_count}")
        logger.info(f"- Average FPS: {final_fps:.2f}")
        logger.info(f"- Total processing time: {elapsed_time:.2f}s")

        # Final capacity report
        for zone_id, zone_data in tracker.zones.items():
            count = tracker.zone_counts.get(zone_id, 0)
            capacity = zone_data["capacity_limit"]
            utilization = (count / capacity * 100) if capacity > 0 else 0
            logger.info(
                f"Final zone '{zone_data['name']}': {count}/{capacity} ({utilization:.0f}%)"
            )


if __name__ == "__main__":
    main()
