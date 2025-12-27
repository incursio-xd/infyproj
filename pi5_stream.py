"""
Raspberry Pi 4 - Video Streaming Server with YOLO Processing
Run this on your Raspberry Pi 4 (4GB RAM) with 5MP Camera Module
Optimized for Pi4 hardware limitations
Streams video to laptop and processes YOLO when zones are received
"""

import cv2
import numpy as np
from flask import Flask, Response, request, jsonify
from flask_cors import CORS
import socketio
from ultralytics import YOLO
import json
import threading
import time
from datetime import datetime
import logging
from picamera2 import Picamera2
from libcamera import controls

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Socket.IO client to connect to laptop
sio = socketio.Client()

class Pi4CameraProcessor:
    def __init__(self, laptop_url="http://192.168.137.1:7000"):
        """
        IMPORTANT: Change laptop_url to YOUR laptop's IP address
        Find your laptop IP with: ipconfig (Windows) or ifconfig (Mac/Linux)
        Example: laptop_url="http://192.168.1.100:7000"
        """
        self.laptop_url = laptop_url
        self.camera = None
        self.model = None
        self.zones = {}
        self.zone_counts = {}
        self.is_processing = False
        self.current_frame = None
        self.lock = threading.Lock()
        
        # Performance tracking
        self.fps = 0
        self.frame_count = 0
        self.start_time = time.time()
        self.last_fps_update = time.time()
        
        # Pi4 optimization settings
        self.process_every_n_frames = 2  # Process every 2nd frame
        self.frame_skip_counter = 0
        self.stream_quality = 70  # JPEG quality
        self.stream_width = 640
        self.stream_height = 480
        
        # Track IDs for person tracking
        self.tracked_objects = {}
        
        # Connect to laptop server
        self.connect_to_laptop()
        
    def connect_to_laptop(self):
        """Connect to laptop's Socket.IO server"""
        try:
            logger.info(f"Attempting to connect to laptop at {self.laptop_url}...")
            sio.connect(self.laptop_url, wait_timeout=10)
            logger.info(f"✓ Connected to laptop server at {self.laptop_url}")
            self.register_socket_handlers()
        except Exception as e:
            logger.error(f"✗ Failed to connect to laptop: {e}")
            logger.info("Will retry connection when sending data...")
    
    def register_socket_handlers(self):
        """Register Socket.IO event handlers"""
        
        @sio.on('connect')
        def on_connect():
            logger.info("Socket.IO connected to laptop")
            sio.emit('pi5_connected', {
                'device': 'Raspberry Pi 4 (4GB)',
                'camera_id': 1,
                'camera_module': '5MP Camera Module'
            })
        
        @sio.on('disconnect')
        def on_disconnect():
            logger.info("Socket.IO disconnected from laptop")
        
        @sio.on('zones_update')
        def on_zones_update(data):
            logger.info(f"Received zones update from laptop")
            self.handle_zones_update(data)
        
        @sio.on('start_processing')
        def on_start_processing(data):
            logger.info("Received start processing command")
            self.handle_start_processing(data)
        
        @sio.on('stop_processing')
        def on_stop_processing(data):
            logger.info("Received stop processing command")
            self.handle_stop_processing(data)
    
    def handle_zones_update(self, data):
        """Receive and process zones from laptop"""
        logger.info(f"Processing zones from laptop: {data}")
        self.zones = data.get('zones', {})
        self.zone_counts = {zone_id: 0 for zone_id in self.zones.keys()}
        logger.info(f"✓ Loaded {len(self.zones)} zones on Pi4")
        
        # Log zone details
        for zone_id, zone_info in self.zones.items():
            logger.info(f"  Zone {zone_id}: {zone_info.get('name', 'Unnamed')} - "
                       f"{len(zone_info.get('coordinates', []))} points")
    
    def handle_start_processing(self, data):
        """Start YOLO processing"""
        if self.is_processing:
            logger.warning("YOLO processing already running")
            return
            
        logger.info("=" * 60)
        logger.info("STARTING YOLO PROCESSING ON RASPBERRY PI 4")
        logger.info("=" * 60)
        
        if not self.zones:
            logger.error("✗ No zones loaded! Cannot start processing.")
            logger.info("  Please sync zones from laptop first.")
            return
        
        self.is_processing = True
        
        if not self.model:
            try:
                logger.info("Loading YOLOv8n (nano) model - optimized for Pi4...")
                self.model = YOLO("yolov8n.pt")
                self.model.fuse()  # Optimize model
                logger.info("✓ YOLO model loaded successfully")
            except Exception as e:
                logger.error(f"✗ Failed to load YOLO model: {e}")
                self.is_processing = False
                return
        
        # Reset tracking
        self.tracked_objects = {}
        self.frame_count = 0
        self.start_time = time.time()
        
        logger.info("✓ YOLO processing started!")
        logger.info(f"  Processing every {self.process_every_n_frames} frames")
        logger.info(f"  Tracking people in {len(self.zones)} zones")
        logger.info("=" * 60)
    
    def handle_stop_processing(self, data):
        """Stop YOLO processing"""
        logger.info("Stopping YOLO processing")
        self.is_processing = False
        self.tracked_objects = {}
        logger.info("✓ YOLO processing stopped")
    
    def start_camera(self):
        """Start Pi4 camera using Picamera2"""
        try:
            logger.info("Initializing Picamera2...")
            self.camera = Picamera2()
            
            # Configure camera
            config = self.camera.create_preview_configuration(
                main={"size": (self.stream_width, self.stream_height), "format": "RGB888"},
                controls={
                    "FrameRate": 15,
                    "ExposureTime": 20000,
                }
            )
            self.camera.configure(config)
            
            # Try to enable autofocus if available
            try:
                self.camera.set_controls({"AfMode": controls.AfModeEnum.Continuous})
                logger.info("✓ Autofocus enabled")
            except:
                logger.info("ℹ Autofocus not available on this camera module")
            
            self.camera.start()
            time.sleep(2)  # Camera warm-up
            
            logger.info(f"✓ Pi4 camera started: {self.stream_width}x{self.stream_height} @ 15 FPS")
            
        except Exception as e:
            logger.error(f"✗ Failed to start camera: {e}")
            logger.info("Falling back to OpenCV camera interface...")
            
            try:
                self.camera = cv2.VideoCapture(0)
                self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, self.stream_width)
                self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, self.stream_height)
                self.camera.set(cv2.CAP_PROP_FPS, 15)
                logger.info("✓ Camera started using OpenCV")
            except Exception as e2:
                logger.error(f"✗ Camera initialization failed: {e2}")
                raise
    
    def get_frame(self):
        """Capture and return current frame"""
        if self.camera is None:
            self.start_camera()
        
        try:
            # Capture frame based on camera type
            if isinstance(self.camera, Picamera2):
                frame = self.camera.capture_array()
                if frame is None:
                    return None
                frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            else:
                ret, frame = self.camera.read()
                if not ret or frame is None:
                    return None
            
            with self.lock:
                self.current_frame = frame.copy()
            
            # Frame skipping for YOLO processing
            self.frame_skip_counter += 1
            should_process = (self.frame_skip_counter % self.process_every_n_frames == 0)
            
            # Process with YOLO if enabled
            if self.is_processing and self.model and self.zones and should_process:
                self.process_frame_with_yolo(frame)
            
            return frame
            
        except Exception as e:
            logger.error(f"Error capturing frame: {e}")
            return None
    
    def process_frame_with_yolo(self, frame):
        """Process frame with YOLO and send results to laptop"""
        try:
            # Resize for faster processing on Pi4
            process_width = 416
            process_height = 416
            process_frame = cv2.resize(frame, (process_width, process_height))
            
            # Run YOLO detection
            results = self.model.track(
                process_frame,
                persist=True,
                verbose=False,
                conf=0.5,
                classes=[0],  # Person class only
                imgsz=416,
                device='cpu',
                half=False
            )
            
            # Scale factor for coordinates
            scale_x = frame.shape[1] / process_width
            scale_y = frame.shape[0] / process_height
            
            # Extract tracked objects
            tracked_objects = []
            for result in results:
                boxes = result.boxes
                if boxes is not None and boxes.id is not None:
                    for i, box in enumerate(boxes):
                        if int(box.cls[0]) == 0:  # Person
                            # Scale coordinates back to original
                            x1, y1, x2, y2 = box.xyxy[0].tolist()
                            x1 = int(x1 * scale_x)
                            y1 = int(y1 * scale_y)
                            x2 = int(x2 * scale_x)
                            y2 = int(y2 * scale_y)
                            
                            track_id = int(boxes.id[i])
                            center_x = (x1 + x2) // 2
                            center_y = (y1 + y2) // 2
                            
                            tracked_objects.append({
                                "id": track_id,
                                "bbox": [x1, y1, x2, y2],
                                "center": (center_x, center_y),
                                "confidence": float(box.conf[0])
                            })
            
            # Update zone counts
            self.update_zone_counts(tracked_objects)
            
            # Calculate FPS
            current_time = time.time()
            if current_time - self.last_fps_update >= 1.0:
                elapsed = current_time - self.start_time
                if elapsed > 0:
                    self.fps = self.frame_count / elapsed
                self.last_fps_update = current_time
            
            self.frame_count += 1
            
            # Send data to laptop
            self.send_processing_data(tracked_objects)
            
        except Exception as e:
            logger.error(f"Error in YOLO processing: {e}")
    
    def update_zone_counts(self, tracked_objects):
        """Update people count in each zone"""
        # Reset all zone counts
        for zone_id in self.zones:
            self.zone_counts[zone_id] = 0
        
        # Count people in zones
        for obj in tracked_objects:
            center = obj["center"]
            
            for zone_id, zone_data in self.zones.items():
                try:
                    coordinates = zone_data.get('coordinates', [])
                    if not coordinates:
                        continue
                    
                    # Handle coordinate format: list of [x, y] pairs or {x, y} dicts
                    if isinstance(coordinates[0], dict):
                        polygon = np.array([(pt['x'], pt['y']) for pt in coordinates], dtype=np.int32)
                    elif isinstance(coordinates[0], (list, tuple)):
                        polygon = np.array(coordinates, dtype=np.int32)
                    else:
                        logger.warning(f"Unknown coordinate format for zone {zone_id}")
                        continue
                    
                    # Check if point is inside polygon
                    if cv2.pointPolygonTest(polygon, center, False) >= 0:
                        self.zone_counts[zone_id] += 1
                        
                except Exception as e:
                    logger.error(f"Error checking zone {zone_id}: {e}")
    
    def send_processing_data(self, tracked_objects):
        """Send processing results to laptop"""
        try:
            # Build zone counts with names
            zone_counts_named = {}
            for zone_id, count in self.zone_counts.items():
                if zone_id in self.zones:
                    zone_name = self.zones[zone_id].get('name', f'Zone {zone_id}')
                    zone_counts_named[zone_name] = count
            
            data = {
                "camera_id": 1,
                "timestamp": datetime.now().isoformat(),
                "total_count": len(tracked_objects),
                "zone_counts": zone_counts_named,
                "fps": round(self.fps, 2),
                "device": "Raspberry Pi 4 (4GB)",
                "camera_module": "5MP Camera Module",
                "processing_time": 0
            }
            
            # Try to reconnect if disconnected
            if not sio.connected:
                try:
                    logger.warning("Socket.IO disconnected, attempting to reconnect...")
                    sio.connect(self.laptop_url, wait_timeout=5)
                except:
                    logger.warning("Cannot reconnect to laptop server")
                    return
            
            # Send via Socket.IO
            if sio.connected:
                sio.emit('pi5_processing_data', data)
                logger.debug(f"📤 Sent: {len(tracked_objects)} people, {self.fps:.1f} FPS, Zones: {zone_counts_named}")
            else:
                logger.warning("Socket.IO not connected, data not sent")
        
        except Exception as e:
            logger.error(f"Error sending data: {e}")
    
    def cleanup(self):
        """Cleanup resources"""
        if self.camera:
            if isinstance(self.camera, Picamera2):
                self.camera.stop()
                self.camera.close()
            else:
                self.camera.release()
            logger.info("✓ Camera released")
        
        if sio.connected:
            sio.disconnect()
            logger.info("✓ Disconnected from Socket.IO")
        
        logger.info("✓ Pi4 processor cleaned up")


# Global processor instance
processor = Pi4CameraProcessor(laptop_url="http://192.168.137.1:7000")

@app.route('/video_feed')
def video_feed():
    """Video streaming route - MJPEG stream"""
    def generate():
        while True:
            try:
                frame = processor.get_frame()
                if frame is None:
                    continue
                
                # Encode as JPEG
                ret, buffer = cv2.imencode('.jpg', frame, 
                                          [cv2.IMWRITE_JPEG_QUALITY, processor.stream_quality])
                if not ret:
                    continue
                
                frame_bytes = buffer.tobytes()
                
                # Yield in MJPEG format
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
                
                time.sleep(0.033)  # ~30 FPS
                
            except Exception as e:
                logger.error(f"Error in video feed: {e}")
                time.sleep(0.1)
    
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/status')
def status():
    """Get Pi4 status"""
    return jsonify({
        "status": "running",
        "device": "Raspberry Pi 4 (4GB RAM)",
        "camera_module": "5MP Camera Module",
        "camera_active": processor.camera is not None,
        "processing_active": processor.is_processing,
        "zones_loaded": len(processor.zones),
        "fps": round(processor.fps, 2),
        "stream_resolution": f"{processor.stream_width}x{processor.stream_height}",
        "connected_to_laptop": sio.connected
    })

@app.route('/zones', methods=['POST'])
def receive_zones():
    """Receive zones from laptop via HTTP"""
    data = request.json
    processor.zones = data.get('zones', {})
    processor.zone_counts = {zone_id: 0 for zone_id in processor.zones.keys()}
    logger.info(f"✓ Received {len(processor.zones)} zones from laptop via HTTP")
    return jsonify({"success": True, "zones_count": len(processor.zones)})

@app.route('/start_processing', methods=['POST'])
def start_processing():
    """Start YOLO processing via HTTP"""
    processor.handle_start_processing({})
    return jsonify({"success": True, "message": "Processing started on Pi4"})

@app.route('/stop_processing', methods=['POST'])
def stop_processing():
    """Stop YOLO processing via HTTP"""
    processor.handle_stop_processing({})
    return jsonify({"success": True, "message": "Processing stopped"})

@app.route('/config', methods=['POST'])
def update_config():
    """Update Pi4 configuration"""
    data = request.json
    
    if 'process_every_n_frames' in data:
        processor.process_every_n_frames = int(data['process_every_n_frames'])
        logger.info(f"Updated frame skip: process every {processor.process_every_n_frames} frames")
    
    if 'stream_quality' in data:
        processor.stream_quality = int(data['stream_quality'])
        logger.info(f"Updated stream quality: {processor.stream_quality}%")
    
    return jsonify({"success": True, "message": "Configuration updated"})

if __name__ == '__main__':
    print("=" * 70)
    print("🎥 RASPBERRY PI 4 - CAMERA STREAMING & YOLO PROCESSING SERVER")
    print("=" * 70)
    print(f"📍 Laptop URL: {processor.laptop_url}")
    print(f"📹 Stream Resolution: {processor.stream_width}x{processor.stream_height}")
    print(f"⚡ Frame Processing: Every {processor.process_every_n_frames} frames")
    print(f"🖼️  JPEG Quality: {processor.stream_quality}%")
    print("=" * 70)
    print("\n🔧 OPTIMIZATIONS FOR RASPBERRY PI 4:")
    print("   ✓ Using Picamera2 for native camera support")
    print("   ✓ Reduced resolution (640x480) for better performance")
    print("   ✓ Frame skipping (every 2nd frame) for YOLO")
    print("   ✓ Lower JPEG quality for faster streaming")
    print("   ✓ YOLOv8n (nano) model for minimal resource usage")
    print("   ✓ CPU-optimized inference (no GPU needed)")
    print("=" * 70)
    print("\n🌐 SERVER ENDPOINTS:")
    print(f"   • Video Stream: http://<PI4_IP>:5000/video_feed")
    print(f"   • Status: http://<PI4_IP>:5000/status")
    print(f"   • Receive Zones: POST http://<PI4_IP>:5000/zones")
    print(f"   • Start Processing: POST http://<PI4_IP>:5000/start_processing")
    print(f"   • Stop Processing: POST http://<PI4_IP>:5000/stop_processing")
    print("=" * 70)
    print("\n⚠️  IMPORTANT CONFIGURATION:")
    print(f"   1. UPDATE LINE 39: Change laptop_url to YOUR laptop IP")
    print(f"      Current: {processor.laptop_url}")
    print(f"      Example: http://192.168.1.100:7000")
    print("\n   2. On laptop, update server.js line 21 with Pi4 IP:")
    print(f"      Current Pi4 IP should match Pi4_IP in config")
    print("=" * 70)
    print("\n🚀 Starting Flask server on http://0.0.0.0:5000")
    print("   Press CTRL+C to stop")
    print("=" * 70)
    
    try:
        app.run(host='0.0.0.0', port=5000, threaded=True, debug=False)
    except KeyboardInterrupt:
        print("\n\n🛑 Shutting down...")
        processor.cleanup()
        print("✓ Server stopped gracefully")