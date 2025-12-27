const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ============================================================================
// PI5 CONFIGURATION - UPDATE THIS WITH YOUR PI5'S IP ADDRESS
// ============================================================================
const PI5_CONFIG = {
    enabled: true,
    ip: process.env.PI5_IP || '192.168.137.48', // CHANGE THIS TO YOUR PI5 IP
    streamPort: 5000,
    get streamUrl() {
        return `http://${this.ip}:${this.streamPort}`;
    }
};

const PI5_BASE_URL = PI5_CONFIG.streamUrl;
const JWT_SECRET = 'your_jwt_secret_here';

// ============================================================================
// MULTER CONFIGURATION FOR VIDEO UPLOADS
// ============================================================================
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'video-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /mp4|avi|mov|wmv|flv|webm|mkv/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'));
        }
    }
});

// ============================================================================
// MIDDLEWARE
// ============================================================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use((req, res, next) => {
    req.io = io;
    next();
});

// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================
const activeProcesses = new Map();
const processStatus = new Map();
let yoloProcesses = new Map();
let yoloProcessStatus = new Map();

// ============================================================================
// DATABASE SETUP
// ============================================================================
const db = new sqlite3.Database('./auth.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
    } else {
        console.log('Connected to SQLite database');
        createTables();
    }
});

function dbQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) {
                console.error('Database error:', err);
                console.error('Query:', query);
                console.error('Params:', params);
                reject(err);
            } else {
                resolve({
                    id: this.lastID,
                    changes: this.changes,
                    success: true
                });
            }
        });
    });
}

function createTables() {
    const createUsersTable = `
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT,
            email TEXT,
            role TEXT NOT NULL DEFAULT 'employee',
            department TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME
        )
    `;

    const createCameraDataTable = `
        CREATE TABLE IF NOT EXISTS camera_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id INTEGER,
            total_count INTEGER,
            active_tracks INTEGER DEFAULT 0,
            zone_counts TEXT,
            processing_time REAL DEFAULT 0,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            fps REAL,
            capacity_warnings INTEGER DEFAULT 0,
            capacity_violations INTEGER DEFAULT 0,
            peak_hour_count INTEGER DEFAULT 0
        )
    `;

    const createZonesTable = `
        CREATE TABLE IF NOT EXISTS zones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            coordinates TEXT NOT NULL,
            camera_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            capacity_limit INTEGER DEFAULT 50,
            warning_threshold INTEGER DEFAULT 40,
            alert_color TEXT DEFAULT '#4ecdc4',
            video_width INTEGER,
            video_height INTEGER,
            canvas_width INTEGER,
            canvas_height INTEGER,
            created_for_camera_type TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `;

    const createVideosTable = `
        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_name TEXT NOT NULL,
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            size INTEGER,
            user_id INTEGER NOT NULL,
            is_current BOOLEAN DEFAULT 0,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `;

    const createZoneAnalyticsTable = `
        CREATE TABLE IF NOT EXISTS zone_analytics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            zone_id INTEGER NOT NULL,
            camera_id INTEGER NOT NULL,
            people_count INTEGER NOT NULL,
            capacity_utilization REAL NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE
        )
    `;

    const createCapacityViolationsTable = `
        CREATE TABLE IF NOT EXISTS capacity_violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            zone_id INTEGER NOT NULL,
            camera_id INTEGER NOT NULL,
            zone_name TEXT NOT NULL,
            people_count INTEGER NOT NULL,
            capacity_limit INTEGER NOT NULL,
            violation_type TEXT NOT NULL,
            violation_start DATETIME DEFAULT CURRENT_TIMESTAMP,
            violation_end DATETIME,
            duration_seconds INTEGER,
            FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE
        )
    `;

    const createAnalyticsSummaryTable = `
        CREATE TABLE IF NOT EXISTS analytics_summary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id INTEGER NOT NULL,
            total_people INTEGER NOT NULL,
            zones_at_capacity INTEGER DEFAULT 0,
            zones_at_warning INTEGER DEFAULT 0,
            peak_occupancy INTEGER NOT NULL,
            avg_occupancy REAL NOT NULL,
            hour_of_day INTEGER NOT NULL,
            date_recorded DATE NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;

    const createIndexes = [
        `CREATE INDEX IF NOT EXISTS idx_zone_analytics_timestamp ON zone_analytics(timestamp)`,
        `CREATE INDEX IF NOT EXISTS idx_zone_analytics_zone_id ON zone_analytics(zone_id)`,
        `CREATE INDEX IF NOT EXISTS idx_capacity_violations_zone_id ON capacity_violations(zone_id)`,
        `CREATE INDEX IF NOT EXISTS idx_capacity_violations_timestamp ON capacity_violations(violation_start)`,
        `CREATE INDEX IF NOT EXISTS idx_analytics_summary_date ON analytics_summary(date_recorded)`
    ];

    db.run(createUsersTable);
    db.run(createCameraDataTable);
    db.run(createZonesTable);
    db.run(createVideosTable);
    db.run(createZoneAnalyticsTable);
    db.run(createCapacityViolationsTable);
    db.run(createAnalyticsSummaryTable);

    createIndexes.forEach(sql => {
        db.run(sql, (err) => {
            if (err && !err.message.includes('already exists')) {
                console.error('Error creating index:', err);
            }
        });
    });

    console.log('Database tables and indexes created/updated successfully');
}

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// ============================================================================
// PI5 INTEGRATION ENDPOINTS
// ============================================================================

// Proxy Pi5 video stream
app.get('/api/pi5-stream', async (req, res) => {
    try {
        const streamUrl = `${PI5_BASE_URL}/video_feed`;
        
        const response = await axios({
            method: 'GET',
            url: streamUrl,
            responseType: 'stream',
            timeout: 30000
        });
        
        res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Error proxying Pi5 stream:', error.message);
        res.status(500).json({ 
            error: 'Failed to connect to Pi5 camera stream',
            details: error.message,
            pi5_url: PI5_BASE_URL
        });
    }
});

// Check Pi5 status
app.get('/api/pi5-status', async (req, res) => {
    try {
        const response = await axios.get(`${PI5_BASE_URL}/status`, { timeout: 3000 });
        res.json({ 
            available: true, 
            ...response.data,
            pi5_url: PI5_BASE_URL 
        });
    } catch (error) {
        res.json({ 
            available: false, 
            error: error.message,
            pi5_url: PI5_BASE_URL 
        });
    }
});

// Get Pi5 configuration
app.get('/api/pi5-config', authenticateToken, (req, res) => {
    res.json({
        enabled: PI5_CONFIG.enabled,
        streamUrl: `${PI5_CONFIG.streamUrl}/video_feed`,
        apiUrl: PI5_CONFIG.streamUrl,
        ip: PI5_CONFIG.ip
    });
});

// Sync zones to Pi5
// In server.js - around line 358
app.post('/api/zones/sync-to-pi5', authenticateToken, async (req, res) => {
    try {
        const { cameraId } = req.body;
        const userId = req.user.id;
        
        console.log(`[SYNC] Syncing zones for camera ${cameraId || 1}, user ${userId}`);
        
        // Get zones for camera 1 (Pi5 camera)
        const zones = await dbQuery(`
            SELECT id, name, coordinates, capacity_limit, warning_threshold, 
                   video_width, video_height
            FROM zones 
            WHERE camera_id = ? AND user_id = ?
            ORDER BY created_at DESC
        `, [cameraId || 1, userId]);
        
        console.log(`[SYNC] Found ${zones.length} zones in database`);
        
        if (zones.length === 0) {
            return res.json({ 
                success: false, 
                message: 'No zones found for camera 1',
                zones_synced: 0
            });
        }
        
        // Format zones for Pi5
        const pi5Zones = {};
        zones.forEach(zone => {
            try {
                const coordinates = JSON.parse(zone.coordinates);
                console.log(`[SYNC] Zone ${zone.id} "${zone.name}": ${coordinates.length} points`);
                
                pi5Zones[zone.id] = {
                    name: zone.name,
                    coordinates: coordinates,
                    capacity_limit: zone.capacity_limit || 50,
                    warning_threshold: zone.warning_threshold || 40,
                    video_width: zone.video_width,
                    video_height: zone.video_height
                };
            } catch (e) {
                console.error(`[SYNC] Error parsing zone ${zone.id} coordinates:`, e);
            }
        });
        
        console.log(`[SYNC] Sending ${Object.keys(pi5Zones).length} zones to Pi5 at ${PI5_BASE_URL}`);
        
        // Send to Pi5
        const pi5Response = await axios.post(`${PI5_BASE_URL}/zones`, 
            { zones: pi5Zones },
            { 
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            }
        );
        
        if (pi5Response.status === 200) {
            console.log(`[SYNC] Successfully synced ${zones.length} zones to Pi5`);
            res.json({ 
                success: true, 
                message: `${zones.length} zones synced to Pi5`,
                zones_synced: zones.length,
                zone_names: zones.map(z => z.name)
            });
        } else {
            throw new Error(`Pi5 returned status ${pi5Response.status}`);
        }
        
    } catch (error) {
        console.error('[SYNC] Error syncing zones to Pi5:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Failed to sync zones to Pi5',
            details: error.message,
            pi5_available: false
        });
    }
});
// Start Pi5 processing
app.post('/api/pi5/start-processing', authenticateToken, async (req, res) => {
    try {
        const response = await axios.post(`${PI5_BASE_URL}/start_processing`, {}, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.status === 200) {
            res.json({ 
                success: true, 
                message: 'Pi5 processing started successfully',
                streamUrl: `${PI5_BASE_URL}/video_feed`
            });
        } else {
            throw new Error(`Pi5 returned status ${response.status}`);
        }
    } catch (error) {
        console.error('Error starting Pi5 processing:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to start Pi5 processing',
            details: error.message
        });
    }
});

// Stop Pi5 processing
app.post('/api/pi5/stop-processing', authenticateToken, async (req, res) => {
    try {
        const response = await axios.post(`${PI5_BASE_URL}/stop_processing`, {}, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.status === 200) {
            res.json({ 
                success: true, 
                message: 'Pi5 processing stopped successfully' 
            });
        } else {
            throw new Error(`Pi5 returned status ${response.status}`);
        }
    } catch (error) {
        console.error('Error stopping Pi5 processing:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to stop Pi5 processing',
            details: error.message
        });
    }
});

// ============================================================================
// YOLO PROCESSING ENDPOINTS (LOCAL - CAMERA 2)
// ============================================================================

app.post('/api/start-yolo', authenticateToken, async (req, res) => {
    const { cameraType, cameraIndex, cameraId } = req.body;
    const userId = req.user.id;

    if (!cameraId) {
        return res.status(400).json({ error: 'Camera ID is required' });
    }

    // CAMERA 1 = PI5 (Forward to Pi5)
    if (cameraId === 1) {
        try {
            console.log('Camera 1 detected - forwarding to Pi5');
            const response = await axios.post(`${PI5_BASE_URL}/start_processing`, {}, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.status === 200) {
                return res.json({
                    success: true,
                    message: 'Pi5 processing started',
                    cameraId: 1,
                    device: 'Raspberry Pi 5'
                });
            } else {
                throw new Error('Pi5 did not respond successfully');
            }
        } catch (error) {
            console.error('Error starting Pi5:', error);
            return res.status(500).json({ 
                success: false,
                error: 'Failed to start Pi5 processing',
                details: error.message
            });
        }
    }

    // CAMERA 2+ = LOCAL YOLO PROCESSING
    if (yoloProcesses.has(cameraId)) {
        return res.status(400).json({ error: 'YOLO process already running for this camera' });
    }

    try {
        let args = [
            'yolo_processor.py',
            '--camera-id', cameraId.toString(),
            '--db-url', `http://localhost:${PORT || 7000}`
        ];

        if (cameraType === 'live' && cameraIndex !== undefined) {
            args.push('--camera', cameraIndex.toString());
        } else if (cameraType === 'video') {
            const currentVideoQuery = 'SELECT * FROM videos WHERE user_id = ? AND is_current = 1';
            db.get(currentVideoQuery, [userId], (err, video) => {
                if (err || !video) {
                    return res.status(400).json({
                        error: 'No current video selected. Please select a video first.'
                    });
                }

                const videoPath = path.isAbsolute(video.path) ? video.path : path.join(__dirname, video.path);
                args.push('--video', videoPath);

                startYOLOProcess(cameraId, args, res, userId, 'video');
            });
            return;
        } else {
            return res.status(400).json({ error: 'Invalid camera configuration' });
        }

        startYOLOProcess(cameraId, args, res, userId, cameraType);

    } catch (error) {
        console.error('Error starting YOLO process:', error);
        res.status(500).json({ error: 'Failed to start YOLO process' });
    }
});

app.post('/api/pi5-data', (req, res) => {
    try {
        const data = req.body;
        console.log('[PI5 DATA] Received:', data);
        
        // Store in database
        storeCameraData({
            camera_id: data.camera_id || 1,
            total_count: data.total_count || 0,
            active_tracks: 0,
            zone_counts: data.zone_counts || {},
            fps: data.fps || 0,
            processing_time: data.processing_time || 0,
            timestamp: data.timestamp || new Date().toISOString()
        });
        
        // Broadcast to all connected clients via Socket.IO
        io.emit('live_camera_data', {
            camera_id: data.camera_id || 1,
            total_count: data.total_count || 0,
            zone_counts: data.zone_counts || {},
            fps: data.fps || 0,
            timestamp: data.timestamp || new Date().toISOString(),
            device: data.device || 'Pi5'
        });
        
        io.emit('pi5_processing_data', data);
        
        res.json({ success: true, message: 'Data received' });
        
    } catch (error) {
        console.error('[PI5 DATA] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function startYOLOProcess(cameraId, args, res, userId, cameraType) {
    console.log('Starting YOLO process with args:', args);

    const yoloProcess = spawn('python', args, {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    yoloProcesses.set(cameraId, yoloProcess);
    yoloProcessStatus.set(cameraId, {
        status: 'starting',
        pid: yoloProcess.pid,
        startTime: new Date().toISOString(),
        cameraType,
        userId
    });

    yoloProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`YOLO ${cameraId} stdout:`, output);

        io.emit('yolo_process_output', {
            cameraId,
            type: 'stdout',
            message: output.trim()
        });

        if (output.includes('YOLO processor ready') || output.includes('Starting processing')) {
            yoloProcessStatus.set(cameraId, {
                ...yoloProcessStatus.get(cameraId),
                status: 'running'
            });

            io.emit('yolo_process_status', {
                cameraId,
                status: 'running',
                message: 'YOLO processor is running and ready'
            });
        }
    });

    yoloProcess.stderr.on('data', (data) => {
        const error = data.toString();
        console.error(`YOLO ${cameraId} stderr:`, error);

        if (!error.includes('INFO') && !error.includes('DEBUG')) {
            io.emit('yolo_process_output', {
                cameraId,
                type: 'stderr',
                message: error.trim()
            });
        }
    });

    yoloProcess.on('close', (code) => {
        console.log(`YOLO process ${cameraId} exited with code ${code}`);

        const status = yoloProcessStatus.get(cameraId);
        yoloProcessStatus.set(cameraId, {
            ...status,
            status: code === 0 ? 'stopped' : 'error',
            exitCode: code,
            endTime: new Date().toISOString()
        });

        io.emit('yolo_process_status', {
            cameraId,
            status: code === 0 ? 'stopped' : 'error',
            exitCode: code,
            message: `YOLO process ${code === 0 ? 'stopped normally' : 'stopped with error'}`
        });

        setTimeout(() => {
            yoloProcesses.delete(cameraId);
            yoloProcessStatus.delete(cameraId);
        }, 5000);
    });

    yoloProcess.on('error', (err) => {
        console.error(`YOLO process ${cameraId} error:`, err);

        yoloProcessStatus.set(cameraId, {
            ...yoloProcessStatus.get(cameraId),
            status: 'error',
            error: err.message,
            endTime: new Date().toISOString()
        });

        io.emit('yolo_process_status', {
            cameraId,
            status: 'error',
            error: err.message,
            message: `YOLO process error: ${err.message}`
        });

        yoloProcesses.delete(cameraId);
    });

    setTimeout(() => {
        if (yoloProcesses.has(cameraId)) {
            yoloProcessStatus.set(cameraId, {
                ...yoloProcessStatus.get(cameraId),
                status: 'initializing'
            });

            io.emit('yolo_process_status', {
                cameraId,
                status: 'initializing',
                message: 'YOLO process initializing...'
            });
        }
    }, 2000);

    res.json({
        message: 'YOLO process started successfully',
        cameraId,
        pid: yoloProcess.pid,
        status: 'starting'
    });
}

app.post('/api/stop-yolo', authenticateToken, async (req, res) => {
    const { cameraId } = req.body;

    if (!cameraId) {
        return res.status(400).json({ error: 'Camera ID is required' });
    }

    // If Camera 1 (Pi5), forward to Pi5
    if (cameraId === 1) {
        try {
            const response = await axios.post(`${PI5_BASE_URL}/stop_processing`, {}, {
                timeout: 5000
            });
            return res.json({
                success: true,
                message: 'Pi5 processing stopped',
                cameraId: 1
            });
        } catch (error) {
            console.error('Error stopping Pi5:', error);
            return res.status(500).json({ 
                error: 'Failed to stop Pi5 processing',
                details: error.message
            });
        }
    }

    // Local YOLO process (Camera 2+)
    const yoloProcess = yoloProcesses.get(cameraId);

    if (!yoloProcess) {
        return res.status(404).json({ error: 'No YOLO process found for this camera' });
    }

    try {
        console.log(`Stopping YOLO process for camera ${cameraId}`);
        yoloProcess.kill('SIGTERM');

        setTimeout(() => {
            if (yoloProcesses.has(cameraId)) {
                console.log(`Force killing YOLO process ${cameraId}`);
                yoloProcess.kill('SIGKILL');
            }
        }, 5000);

        yoloProcessStatus.set(cameraId, {
            ...yoloProcessStatus.get(cameraId),
            status: 'stopping',
            stopTime: new Date().toISOString()
        });

        io.emit('yolo_process_status', {
            cameraId,
            status: 'stopping',
            message: 'Stopping YOLO process...'
        });

        res.json({
            message: 'YOLO process stop initiated',
            cameraId
        });

    } catch (error) {
        console.error('Error stopping YOLO process:', error);
        res.status(500).json({ error: 'Failed to stop YOLO process' });
    }
});

app.get('/api/yolo-status', authenticateToken, (req, res) => {
    const { cameraId } = req.query;

    if (cameraId) {
        const status = yoloProcessStatus.get(parseInt(cameraId));
        if (!status) {
            return res.json({
                cameraId: parseInt(cameraId),
                status: 'stopped',
                message: 'No active process'
            });
        }
        res.json({ cameraId: parseInt(cameraId), ...status });
    } else {
        const allStatuses = Array.from(yoloProcessStatus.entries()).map(([id, status]) => ({
            cameraId: id,
            ...status
        }));
        res.json(allStatuses);
    }
});

app.get('/api/yolo-processes', authenticateToken, (req, res) => {
    const processes = Array.from(yoloProcesses.entries()).map(([cameraId, process]) => {
        const status = yoloProcessStatus.get(cameraId);
        return {
            cameraId,
            pid: process.pid,
            ...status
        };
    });

    res.json(processes);
});

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.emit('processing_status_update', Array.from(processStatus.entries()));
    socket.emit('yolo_processes_update', Array.from(yoloProcessStatus.entries()));

    // Handle Pi5 processing data - SINGLE UNIFIED HANDLER
    socket.on('pi5_processing_data', (data) => {
        console.log('Received Pi5 processing data:', data);
        
        // Store in database
        storeCameraData({
            camera_id: data.camera_id || 1,
            total_count: data.total_count || 0,
            active_tracks: 0,
            zone_counts: data.zone_counts || {},
            fps: data.fps || 0,
            processing_time: data.processing_time || 0,
            timestamp: data.timestamp || new Date().toISOString()
        });
        
        // Broadcast to all clients
        io.emit('live_camera_data', {
            camera_id: data.camera_id || 1,
            total_count: data.total_count || 0,
            zone_counts: data.zone_counts || {},
            fps: data.fps || 0,
            timestamp: data.timestamp || new Date().toISOString(),
            device: 'Pi5'
        });
        
        io.emit('live_analytics_data', {
            camera_id: data.camera_id || 1,
            timestamp: data.timestamp || new Date().toISOString(),
            total_people: data.total_count || 0,
            zones: data.zone_counts || {},
            performance: {
                fps: data.fps || 0,
                device: 'Pi5',
                processing_time: data.processing_time || 0
            }
        });
    });

    socket.on('camera_data', (data) => {
        const enhancedData = {
            ...data,
            timestamp: new Date().toISOString(),
            server_processed: true
        };

        storeCameraData(enhancedData);
        io.emit('live_camera_data', enhancedData);
    });

    socket.on('analytics_data_update', async (data) => {
        console.log('Analytics data received:', data);

        try {
            await storeCameraAnalytics(data);

            if (data.capacity_violations && Array.isArray(data.capacity_violations)) {
                for (const violation of data.capacity_violations) {
                    violation.camera_id = violation.camera_id || data.camera_id;
                    await storeCapacityViolation(violation);
                    io.emit('capacity_violation_alert', violation);
                }
            }

            io.emit('live_analytics_data', data);

        } catch (error) {
            console.error('Error processing analytics data:', error);
        }
    });

    socket.on('capacity_violation', async (violationData) => {
        console.log('Capacity violation received:', violationData);

        try {
            const normalizedViolation = {
                zone_id: violationData.zone_id || null,
                camera_id: violationData.camera_id || 1,
                zone_name: violationData.zone_name || 'Unknown Zone',
                people_count: violationData.people_count || 0,
                capacity_limit: violationData.capacity_limit || 0,
                violation_type: violationData.violation_type || violationData.type || 'unknown',
                violation_start: violationData.violation_start || violationData.timestamp || new Date().toISOString(),
                ongoing: violationData.ongoing || false
            };

            if (!normalizedViolation.ongoing) {
                const result = await dbRun(`
                    INSERT INTO capacity_violations 
                    (zone_id, camera_id, zone_name, people_count, capacity_limit, violation_type, violation_start)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    normalizedViolation.zone_id,
                    normalizedViolation.camera_id,
                    normalizedViolation.zone_name,
                    normalizedViolation.people_count,
                    normalizedViolation.capacity_limit,
                    normalizedViolation.violation_type,
                    normalizedViolation.violation_start
                ]);

                normalizedViolation.id = result.id;
                console.log(`Stored capacity violation ${result.id} for zone ${normalizedViolation.zone_name}`);
            }

            io.emit('capacity_violation_alert', normalizedViolation);

        } catch (error) {
            console.error('Error handling capacity violation:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// ============================================================================
// DATA STORAGE FUNCTIONS
// ============================================================================

function storeCameraData(data) {
    const { camera_id, total_count, active_tracks, zone_counts, fps, processing_time } = data;

    db.run(`INSERT INTO camera_data (camera_id, total_count, active_tracks, zone_counts, fps, processing_time) 
            VALUES (?, ?, ?, ?, ?, ?)`,
        [camera_id, total_count, active_tracks || 0, JSON.stringify(zone_counts), fps, processing_time || 0],
        function (err) {
            if (err) {
                console.error('Error storing camera data:', err);
            }
        });
}

function storeCameraAnalytics(data) {
    try {
        const enhancedData = {
            camera_id: data.camera_id,
            total_count: data.total_people,
            active_tracks: 0,
            zone_counts: JSON.stringify(data.zones || {}),
            fps: data.performance ? data.performance.fps : 0,
            processing_time: data.performance ? data.performance.processing_time : 0,
            capacity_warnings: data.summary ? data.summary.zones_at_warning : 0,
            capacity_violations: data.summary ? data.summary.zones_at_capacity : 0,
            peak_hour_count: data.total_people || 0,
            timestamp: new Date().toISOString()
        };

        db.run(`INSERT INTO camera_data (
            camera_id, total_count, active_tracks, zone_counts, fps, processing_time,
            capacity_warnings, capacity_violations, peak_hour_count, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                enhancedData.camera_id,
                enhancedData.total_count,
                enhancedData.active_tracks,
                enhancedData.zone_counts,
                enhancedData.fps,
                enhancedData.processing_time,
                enhancedData.capacity_warnings,
                enhancedData.capacity_violations,
                enhancedData.peak_hour_count,
                enhancedData.timestamp
            ], function (err) {
                if (err) {
                    console.error('Error storing analytics data:', err);
                }
            });

        if (data.zones) {
            Object.entries(data.zones).forEach(([zoneName, zoneData]) => {
                storeZoneAnalytics(data.camera_id, zoneName, zoneData);
            });
        }

    } catch (error) {
        console.error('Error in storeCameraAnalytics:', error);
    }
}

function storeZoneAnalytics(cameraId, zoneName, zoneData) {
    db.get('SELECT id FROM zones WHERE camera_id = ? AND name = ?', [cameraId, zoneName], (err, zone) => {
        if (err || !zone) {
            console.error('Zone not found for analytics:', zoneName);
            return;
        }

        db.run(`INSERT INTO zone_analytics (
            zone_id, camera_id, people_count, capacity_utilization, timestamp
        ) VALUES (?, ?, ?, ?, ?)`,
            [
                zone.id,
                cameraId,
                zoneData.count || 0,
                zoneData.utilization || 0,
                new Date().toISOString()
            ], (err) => {
                if (err) {
                    console.error('Error storing zone analytics:', err);
                }
            });
    });
}

async function storeCapacityViolation(violation) {
    try {
        const normalizedViolation = {
            zone_id: violation.zone_id || null,
            camera_id: violation.camera_id || 1,
            zone_name: violation.zone_name || 'Unknown Zone',
            people_count: violation.people_count || 0,
            capacity_limit: violation.capacity_limit || 0,
            violation_type: violation.violation_type || violation.type || 'unknown',
            violation_start: violation.violation_start || violation.timestamp || new Date().toISOString()
        };

        const result = await dbRun(`
            INSERT INTO capacity_violations (
                zone_id, camera_id, zone_name, people_count, capacity_limit, 
                violation_type, violation_start
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            normalizedViolation.zone_id,
            normalizedViolation.camera_id,
            normalizedViolation.zone_name,
            normalizedViolation.people_count,
            normalizedViolation.capacity_limit,
            normalizedViolation.violation_type,
            normalizedViolation.violation_start
        ]);

        console.log(`Capacity violation stored successfully: ID ${result.id}`);
        return { success: true, id: result.id };

    } catch (error) {
        console.error('Error storing capacity violation:', error);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

app.post('/api/login', async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required' });
        }

        db.get('SELECT * FROM users WHERE username = ? AND role = ?', [username, role], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

            const token = jwt.sign(
                { id: user.id, username: user.username, role: user.role },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            res.json({
                message: 'Login successful',
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    full_name: user.full_name,
                    role: user.role
                },
                redirectUrl: '/employee-dashboard'
            });
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { full_name, email, username, password, department } = req.body;

        if (!full_name || !email || !username || !password) {
            return res.status(400).json({ error: 'Full name, email, username, and password are required' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        db.get('SELECT username FROM users WHERE username = ?', [username], async (err, existingUser) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (existingUser) {
                return res.status(400).json({ error: 'Username already exists' });
            }

            db.get('SELECT email FROM users WHERE email = ?', [email], async (err, existingEmail) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }

                if (existingEmail) {
                    return res.status(400).json({ error: 'Email already exists' });
                }

                try {
                    const hashedPassword = await bcrypt.hash(password, 10);

                    db.run(`INSERT INTO users (username, password, full_name, email, department, role) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [username, hashedPassword, full_name, email, department, 'employee'],
                        function (err) {
                            if (err) {
                                console.error('Registration error:', err);
                                return res.status(500).json({ error: 'Failed to create account' });
                            }

                            res.status(201).json({
                                message: 'Account created successfully',
                                user: {
                                    id: this.lastID,
                                    username: username,
                                    full_name: full_name,
                                    email: email,
                                    role: 'employee'
                                }
                            });
                        });
                } catch (hashError) {
                    console.error('Password hashing error:', hashError);
                    res.status(500).json({ error: 'Failed to create account' });
                }
            });
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/profile', authenticateToken, (req, res) => {
    db.get('SELECT id, username, full_name, email, role, department, created_at, last_login FROM users WHERE id = ?',
        [req.user.id], (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json(user);
        });
});

// ============================================================================
// ZONE MANAGEMENT ENDPOINTS
// ============================================================================

app.get('/api/zones', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { camera_id } = req.query;

    let query = `SELECT id, name, coordinates, camera_id, user_id, created_at, 
                        capacity_limit, warning_threshold, alert_color,
                        video_width, video_height, canvas_width, canvas_height,
                        created_for_camera_type
                FROM zones WHERE user_id = ?`;
    let params = [userId];

    if (camera_id) {
        query += ' AND camera_id = ?';
        params.push(camera_id);
    }

    query += ' ORDER BY created_at DESC';

    db.all(query, params, (err, zones) => {
        if (err) {
            console.error('Error fetching zones:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const processedZones = zones.map(zone => ({
            ...zone,
            coordinates: JSON.parse(zone.coordinates || '[]'),
            has_dimensions: !!(zone.video_width && zone.video_height)
        }));

        res.json(processedZones);
    });
});

app.post('/api/zones', authenticateToken, (req, res) => {
    const {
        name,
        coordinates,
        camera_id,
        user_id,
        capacity_limit,
        warning_threshold,
        alert_color,
        video_width,
        video_height,
        canvas_width,
        canvas_height
    } = req.body;

    if (!name || !coordinates || !camera_id || !user_id) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!video_width || !video_height) {
        return res.status(400).json({
            error: 'Video dimensions (video_width, video_height) are required'
        });
    }

    const capacity = capacity_limit || 50;
    const warning = warning_threshold || Math.floor(capacity * 0.8);
    const color = alert_color || '#4ecdc4';
    const camera_type = camera_id === 1 ? 'live' : 'video';

    const query = `
        INSERT INTO zones (
            name, coordinates, camera_id, user_id, capacity_limit, 
            warning_threshold, alert_color, video_width, video_height, 
            canvas_width, canvas_height, created_for_camera_type
        ) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(query, [
        name, coordinates, camera_id, user_id, capacity, warning, color,
        video_width, video_height, canvas_width, canvas_height, camera_type
    ], function (err) {
        if (err) {
            console.error('Error creating zone:', err);
            return res.status(500).json({ error: 'Failed to create zone' });
        }

        console.log(`Zone created: "${name}" with dimensions ${video_width}x${video_height}`);

        res.json({
            success: true,
            zone: {
                id: this.lastID,
                name,
                capacity_limit: capacity,
                warning_threshold: warning,
                video_width,
                video_height
            }
        });
    });
});

app.delete('/api/zones/:id', authenticateToken, (req, res) => {
    const zoneId = req.params.id;
    const userId = req.user.id;

    db.get('SELECT * FROM zones WHERE id = ? AND user_id = ?', [zoneId, userId], (err, zone) => {
        if (err) {
            console.error('Error checking zone:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        if (!zone) {
            return res.status(404).json({ error: 'Zone not found or access denied' });
        }

        db.run('DELETE FROM zones WHERE id = ? AND user_id = ?', [zoneId, userId], function (err) {
            if (err) {
                console.error('Error deleting zone:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            io.emit('zones_updated', { camera_id: zone.camera_id });
            res.json({ message: 'Zone deleted successfully' });
        });
    });
});

// ============================================================================
// VIDEO MANAGEMENT ENDPOINTS
// ============================================================================

app.post('/api/upload-video', authenticateToken, upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }

    const { originalname, filename, path: filePath, size } = req.file;
    const userId = req.user.id;

    db.run('UPDATE videos SET is_current = 0 WHERE user_id = ?', [userId], (err) => {
        if (err) {
            console.error('Error updating current videos:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        db.run(`INSERT INTO videos (original_name, filename, path, size, user_id, is_current) 
                VALUES (?, ?, ?, ?, ?, 1)`,
            [originalname, filename, filePath, size, userId],
            function (err) {
                if (err) {
                    console.error('Error saving video:', err);
                    return res.status(500).json({ error: 'Database error' });
                }

                res.json({
                    message: 'Video uploaded successfully',
                    video: {
                        id: this.lastID,
                        original_name: originalname,
                        filename: filename,
                        size: size,
                        uploaded_at: new Date().toISOString()
                    }
                });
            });
    });
});

app.get('/api/videos', authenticateToken, (req, res) => {
    const userId = req.user.id;

    db.all('SELECT id, original_name, filename, size, is_current, uploaded_at FROM videos WHERE user_id = ? ORDER BY uploaded_at DESC',
        [userId], (err, videos) => {
            if (err) {
                console.error('Error fetching videos:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(videos);
        });
});

// ============================================================================
// ANALYTICS ENDPOINTS
// ============================================================================

app.get('/api/analytics-data', async (req, res) => {
    try {
        const range = req.query.range || '1h';
        const cameraId = req.query.camera_id || 1;

        const now = new Date();
        let startTime;

        switch (range) {
            case '1h':
                startTime = new Date(now.getTime() - 60 * 60 * 1000);
                break;
            case '6h':
                startTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
                break;
            case '24h':
                startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            default:
                startTime = new Date(now.getTime() - 60 * 60 * 1000);
        }

        const timelineQuery = `
            SELECT 
                timestamp, 
                total_count, 
                zone_counts,
                fps,
                processing_time,
                capacity_warnings,
                capacity_violations
            FROM camera_data 
            WHERE camera_id = ? AND timestamp >= ? 
            ORDER BY timestamp ASC
        `;

        const timelineData = await dbQuery(timelineQuery, [cameraId, startTime.toISOString()]);

        if (timelineData && timelineData.length > 0) {
            const timeline = timelineData.map(row => ({
                timestamp: row.timestamp,
                total_count: row.total_count || 0,
                zone_counts: row.zone_counts ? JSON.parse(row.zone_counts) : {},
                fps: row.fps || 0,
                processing_time: row.processing_time || 0,
                capacity_warnings: row.capacity_warnings || 0,
                capacity_violations: row.capacity_violations || 0
            }));

            const zones = {};
            timeline.forEach(dataPoint => {
                if (dataPoint.zone_counts) {
                    Object.entries(dataPoint.zone_counts).forEach(([zoneName, count]) => {
                        if (!zones[zoneName]) {
                            zones[zoneName] = [];
                        }
                        zones[zoneName].push({
                            timestamp: dataPoint.timestamp,
                            count: count
                        });
                    });
                }
            });

            res.json({
                timeline,
                zones,
                range,
                start_time: startTime.toISOString(),
                end_time: now.toISOString(),
                data_source: 'real'
            });
        } else {
            res.json({
                timeline: [],
                zones: {},
                range,
                start_time: startTime.toISOString(),
                end_time: now.toISOString(),
                data_source: 'empty',
                message: 'No data available. Start YOLO processing to generate data.'
            });
        }
    } catch (error) {
        console.error('Error fetching analytics data:', error);
        res.status(500).json({
            error: 'Failed to fetch analytics data',
            data_source: 'error'
        });
    }
});

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 500MB.' });
        }
    }

    if (error.message === 'Only video files are allowed') {
        return res.status(400).json({ error: error.message });
    }

    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// HTML PAGE ROUTES
// ============================================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/employee-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'employee-dashboard.html'));
});

app.get('/analytics-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'analytics-dashboard.html'));
});

// Video serving endpoint
app.get('/api/video/:videoId', authenticateToken, (req, res) => {
    const videoId = req.params.videoId;
    const userId = req.user.id;

    db.get('SELECT * FROM videos WHERE id = ? AND user_id = ?', [videoId, userId], (err, video) => {
        if (err || !video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const videoPath = path.isAbsolute(video.path) ? video.path : path.join(__dirname, video.path);
        
        if (!fs.existsSync(videoPath)) {
            return res.status(404).json({ error: 'Video file not found on server' });
        }

        res.sendFile(videoPath);
    });
});

// Set current video
app.post('/api/set-current-video', authenticateToken, (req, res) => {
    const { videoId } = req.body;
    const userId = req.user.id;

    if (!videoId) {
        return res.status(400).json({ error: 'Video ID is required' });
    }

    db.run('UPDATE videos SET is_current = 0 WHERE user_id = ?', [userId], (err) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        db.run('UPDATE videos SET is_current = 1 WHERE id = ? AND user_id = ?', 
            [videoId, userId], 
            function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Video not found' });
                }

                res.json({ 
                    success: true, 
                    message: 'Current video updated',
                    videoId: videoId 
                });
            }
        );
    });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = process.env.PORT || 7000;

function startServer(port) {
    const serverInstance = server.listen(port, () => {
        console.log('\n' + '='.repeat(70));
        console.log('🚀 SERVER STARTED SUCCESSFULLY');
        console.log('='.repeat(70));
        console.log(`📍 Server URL: http://localhost:${port}`);
        console.log(`🔌 WebSocket: Ready for real-time communication`);
        console.log(`🎥 Pi5 Config: ${PI5_CONFIG.ip}:${PI5_CONFIG.streamPort}`);
        console.log(`📊 Camera Data API: /api/camera-data`);
        console.log(`📤 Video Upload: /api/upload-video`);
        console.log(`🤖 YOLO Control: /api/start-yolo, /api/stop-yolo`);
        console.log('='.repeat(70));
        console.log('⚠️  IMPORTANT: Update PI5_CONFIG.ip on line 21 with your Pi5 IP');
        console.log('='.repeat(70) + '\n');
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${port} is busy, trying ${port + 1}...`);
            setTimeout(() => startServer(port + 1), 100);
        } else {
            console.error('Server error:', err);
            process.exit(1);
        }
    });

    function gracefulShutdown(signal) {
        console.log(`\n⚠️  Received ${signal}. Starting graceful shutdown...`);

        if (yoloProcesses.size > 0) {
            console.log('🛑 Stopping YOLO processes...');
            yoloProcesses.forEach((process, cameraId) => {
                console.log(`  Stopping YOLO process for camera ${cameraId}`);
                try {
                    process.kill('SIGTERM');
                } catch (error) {
                    console.error(`  Error stopping YOLO process ${cameraId}:`, error);
                }
            });

            setTimeout(() => {
                yoloProcesses.forEach((process, cameraId) => {
                    if (!process.killed) {
                        console.log(`  Force killing YOLO process for camera ${cameraId}`);
                        try {
                            process.kill('SIGKILL');
                        } catch (error) {
                            console.error(`  Error force killing YOLO process ${cameraId}:`, error);
                        }
                    }
                });
            }, 3000);
        }

        if (io) {
            io.close(() => {
                console.log('✅ WebSocket connections closed');
            });
        }

        if (serverInstance) {
            serverInstance.close((err) => {
                if (err) {
                    console.error('❌ Error during server shutdown:', err);
                }
                console.log('✅ HTTP server closed');

                if (db) {
                    db.close((err) => {
                        if (err) {
                            console.error('❌ Error closing database:', err);
                        } else {
                            console.log('✅ Database connection closed');
                        }
                        console.log('✅ Graceful shutdown completed');
                        process.exit(0);
                    });
                } else {
                    process.exit(0);
                }
            });
        }

        setTimeout(() => {
            console.log('⏱️  Forcing shutdown after timeout');
            process.exit(1);
        }, 10000);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
        console.error('❌ Uncaught Exception:', err);
        gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        gracefulShutdown('unhandledRejection');
    });
}

startServer(PORT);