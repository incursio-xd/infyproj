
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

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const JWT_SECRET = 'your_jwt_secret_here';


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


app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use((req, res, next) => {
    req.io = io;
    next();
});


const activeProcesses = new Map();
const processStatus = new Map();
let yoloProcesses = new Map();
let yoloProcessStatus = new Map();

app.post('/api/start-yolo', authenticateToken, (req, res) => {
    const { cameraType, cameraIndex, cameraId } = req.body;
    const userId = req.user.id;

    if (!cameraId) {
        return res.status(400).json({ error: 'Camera ID is required' });
    }


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


app.post('/api/stop-yolo', authenticateToken, (req, res) => {
    const { cameraId } = req.body;

    if (!cameraId) {
        return res.status(400).json({ error: 'Camera ID is required' });
    }

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


app.get('/api/video/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const video = await db.get('SELECT * FROM videos WHERE id = ? AND user_id = ?', [id, req.user.id]);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const videoPath = path.join(__dirname, 'uploads', video.filename);
        const stat = fs.statSync(videoPath);
        const range = req.headers.range;


        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(videoPath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            });
            file.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(videoPath).pipe(res);
        }
    } catch (error) {
        res.status(500).json({ error: 'Error serving video' });
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


app.get('/api/check-yolo-requirements', authenticateToken, (req, res) => {
    const { exec } = require('child_process');


    exec('python --version', (error, stdout, stderr) => {
        if (error) {

            exec('python3 --version', (error3, stdout3, stderr3) => {
                if (error3) {
                    return res.json({
                        python: false,
                        error: 'Python not found. Please install Python 3.7+',
                        requirements: false,
                        suggestion: 'Install Python from https://python.org or use your package manager'
                    });
                } else {
                    checkPythonPackages('python3', stdout3.trim(), res);
                }
            });
        } else {
            checkPythonPackages('python', stdout.trim(), res);
        }
    });
});

function checkPythonPackages(pythonCmd, version, res) {
    const { exec } = require('child_process');


    const requiredPackages = ['opencv-python', 'ultralytics', 'torch', 'numpy'];
    let checkedCount = 0;
    const results = { python: true, version, requirements: {} };

    requiredPackages.forEach(pkg => {
        exec(`${pythonCmd} -c "import ${pkg.replace('-', '_')}; print('installed')"`, (error, stdout) => {
            results.requirements[pkg] = !error;
            checkedCount++;

            if (checkedCount === requiredPackages.length) {
                const allInstalled = Object.values(results.requirements).every(installed => installed);
                results.allRequirementsMet = allInstalled;
                res.json(results);
            }
        });
    });
}


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
            fps REAL
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

    db.run(createUsersTable);
    db.run(createCameraDataTable);
    db.run(createZonesTable);
    db.run(createVideosTable);
    const addZoneCapacityColumns = [
        `ALTER TABLE zones ADD COLUMN capacity_limit INTEGER DEFAULT 50`,
        `ALTER TABLE zones ADD COLUMN warning_threshold INTEGER DEFAULT 40`,
        `ALTER TABLE zones ADD COLUMN alert_color TEXT DEFAULT '#4ecdc4'`
    ];

    const addCameraDataColumns = [
        `ALTER TABLE camera_data ADD COLUMN capacity_warnings INTEGER DEFAULT 0`,
        `ALTER TABLE camera_data ADD COLUMN capacity_violations INTEGER DEFAULT 0`,
        `ALTER TABLE camera_data ADD COLUMN peak_hour_count INTEGER DEFAULT 0`
    ];

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


    addZoneCapacityColumns.forEach(sql => {
        db.run(sql, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding zone capacity column:', err);
            }
        });
    });

    addCameraDataColumns.forEach(sql => {
        db.run(sql, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.error('Error adding camera data column:', err);
            }
        });
    });


    createIndexes.forEach(sql => {
        db.run(sql, (err) => {
            if (err) {
                console.error('Error creating index:', err);
            }
        });
    });

    console.log('Analytics tables and indexes created/updated successfully');
}


io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);


    socket.emit('processing_status_update', Array.from(processStatus.entries()));
    socket.emit('yolo_processes_update', Array.from(yoloProcessStatus.entries()));

    socket.on('camera_status', (status) => {
        console.log('Camera status update:', status);
        socket.broadcast.emit('camera_status_update', status);
    });

    socket.on('start_camera_processing', (data) => {
        const { cameraId, zones } = data;
        console.log(`Starting processing for camera ${cameraId} with ${zones.length} zones`);

        processStatus.set(cameraId, {
            status: 'starting',
            zones: zones.length,
            timestamp: new Date().toISOString()
        });

        io.emit('camera_processing_status', {
            cameraId,
            status: 'started',
            message: `Processing started for camera ${cameraId}`
        });

        processStatus.set(cameraId, {
            status: 'active',
            zones: zones.length,
            timestamp: new Date().toISOString()
        });
    });

    socket.on('stop_camera_processing', (data) => {
        const { cameraId } = data;
        console.log(`Stopping processing for camera ${cameraId}`);

        processStatus.set(cameraId, {
            status: 'stopped',
            timestamp: new Date().toISOString()
        });

        io.emit('camera_processing_status', {
            cameraId,
            status: 'stopped',
            message: `Processing stopped for camera ${cameraId}`
        });

        setTimeout(() => {
            processStatus.delete(cameraId);
        }, 5000);
    });

    socket.on('yolo_status', (status) => {
        console.log('YOLO status update:', status);

        processStatus.set(status.camera_id, {
            status: status.status,
            zones: status.zones_count || 0,
            message: status.message,
            timestamp: new Date().toISOString()
        });


        socket.broadcast.emit('yolo_status_update', status);
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

    socket.on('request_zone_data', (zoneId, callback) => {
        db.all(`SELECT * FROM camera_data WHERE camera_id = ? 
                ORDER BY timestamp DESC LIMIT 10`, [zoneId], (err, rows) => {
            if (callback) {
                callback({
                    zoneId: zoneId,
                    data: rows || [],
                    error: err ? err.message : null
                });
            }
        });
    });

    socket.on('update_zones', (data) => {
        const { cameraId, zones } = data;
        console.log(`Zones updated for camera ${cameraId}: ${zones.length} zones`);

        socket.broadcast.emit('zones_updated', { camera_id: cameraId });
    });

    socket.on('request_yolo_status', (cameraId, callback) => {
        const status = yoloProcessStatus.get(cameraId);
        if (callback) {
            callback({
                cameraId,
                status: status || { status: 'stopped', message: 'No active process' }
            });
        }
    });

    socket.on('yolo_command', (data) => {
        const { command, cameraId } = data;
        console.log(`YOLO command received: ${command} for camera ${cameraId}`);

        if (command === 'start') {
            socket.emit('yolo_command_response', {
                cameraId,
                status: 'use_api',
                message: 'Please use the Start YOLO button'
            });
        } else if (command === 'stop') {
            const process = yoloProcesses.get(cameraId);
            if (process) {
                console.log(`Stopping YOLO process for camera ${cameraId} via socket`);
                process.kill('SIGTERM');
            }
        }
    });

    socket.on('yolo_process_update', (data) => {
        const { cameraId, status, message } = data;
        console.log(`YOLO process update for camera ${cameraId}: ${status}`);

        if (yoloProcessStatus.has(cameraId)) {
            yoloProcessStatus.set(cameraId, {
                ...yoloProcessStatus.get(cameraId),
                status,
                message,
                lastUpdate: new Date().toISOString()
            });
        }

        io.emit('yolo_process_status', {
            cameraId,
            status,
            message
        });
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


            socket.broadcast.emit('live_analytics_data', data);
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
            socket.broadcast.emit('capacity_violation', normalizedViolation);

        } catch (error) {
            console.error('Error handling capacity violation:', error);
            console.error('Original violation data:', violationData);
        }
    });

    socket.on('request_analytics_data', (cameraId, callback) => {
        getLatestAnalyticsData(cameraId).then(data => {
            if (callback) {
                callback(data);
            }
        }).catch(err => {
            console.error('Error getting analytics data:', err);
            if (callback) {
                callback(null);
            }
        });
    });


    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});


function storeCameraData(data) {
    const { camera_id, total_count, active_tracks, zone_counts, fps, processing_time } = data;

    db.run(`INSERT INTO camera_data (camera_id, total_count, active_tracks, zone_counts, fps, processing_time) 
            VALUES (?, ?, ?, ?, ?, ?)` ,
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
                } else {
                    console.log('Analytics data stored successfully');
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
        console.error('Violation data:', violation);
        return { success: false, error: error.message };
    }
}


function getLatestAnalyticsData(cameraId) {
    return new Promise((resolve) => {
        const query = `
            SELECT * FROM camera_data 
            WHERE camera_id = ? 
            ORDER BY timestamp DESC 
            LIMIT 10
        `;

        db.all(query, [cameraId], (err, rows) => {
            if (err) {
                console.error('Error getting latest analytics:', err);
                resolve(null);
            } else {
                const processedRows = rows.map(row => ({
                    ...row,
                    zone_counts: JSON.parse(row.zone_counts || '{}')
                }));
                resolve(processedRows);
            }
        });
    });
}


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

            const redirectUrl = '/employee-dashboard.html';

            res.json({
                message: 'Login successful',
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    full_name: user.full_name,
                    role: user.role
                },
                redirectUrl
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


app.post('/api/camera-data', (req, res) => {
    const { camera_id, total_count, active_tracks, zone_counts, fps, processing_time } = req.body;

    const enhancedData = {
        camera_id,
        total_count,
        active_tracks: active_tracks || 0,
        zone_counts,
        fps,
        processing_time: processing_time || 0,
        timestamp: new Date().toISOString()
    };

    storeCameraData(enhancedData);


    io.emit('live_camera_data', enhancedData);

    res.json({ message: 'Data received', timestamp: enhancedData.timestamp });
});


app.get('/api/camera-analytics/:cameraId?', authenticateToken, (req, res) => {
    const { cameraId } = req.params;
    const { limit = 50, hours = 24 } = req.query;

    let query = 'SELECT * FROM camera_data WHERE timestamp >= datetime("now", "-' + hours + ' hours")';
    let params = [];

    if (cameraId) {
        query += ' AND camera_id = ?';
        params.push(cameraId);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(parseInt(limit));

    db.all(query, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }


        const processedRows = rows.map(row => ({
            ...row,
            zone_counts: JSON.parse(row.zone_counts || '{}')
        }));

        res.json(processedRows);
    });
});


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
            error: 'Video dimensions (video_width, video_height) are required for proper coordinate scaling'
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


app.get('/api/zones-public', (req, res) => {
    const { camera_id } = req.query;

    if (!camera_id) {
        return res.status(400).json({ error: 'camera_id parameter is required' });
    }

    db.all('SELECT * FROM zones WHERE camera_id = ? ORDER BY created_at DESC', [camera_id], (err, zones) => {
        if (err) {
            console.error('Error fetching zones:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(zones);
    });
});

app.put('/api/zones/:id', authenticateToken, (req, res) => {
    const zoneId = req.params.id;
    const userId = req.user.id;
    const { name, coordinates } = req.body;

    if (!name || !coordinates) {
        return res.status(400).json({ error: 'Name and coordinates are required' });
    }

    db.get('SELECT * FROM zones WHERE id = ? AND user_id = ?', [zoneId, userId], (err, zone) => {
        if (err) {
            console.error('Error checking zone:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        if (!zone) {
            return res.status(404).json({ error: 'Zone not found or access denied' });
        }

        db.run('UPDATE zones SET name = ?, coordinates = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            [name, coordinates, zoneId, userId],
            function (err) {
                if (err) {
                    console.error('Error updating zone:', err);
                    return res.status(500).json({ error: 'Database error' });
                }


                io.emit('zones_updated', { camera_id: zone.camera_id });

                res.json({ message: 'Zone updated successfully' });
            });
    });
});


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

app.post('/api/set-current-video', authenticateToken, (req, res) => {
    const { videoId } = req.body;
    const userId = req.user.id;

    if (!videoId) {
        return res.status(400).json({ error: 'Video ID is required' });
    }


    db.run('UPDATE videos SET is_current = 0 WHERE user_id = ?', [userId], (err) => {
        if (err) {
            console.error('Error resetting current videos:', err);
            return res.status(500).json({ error: 'Database error' });
        }


        db.run('UPDATE videos SET is_current = 1 WHERE id = ? AND user_id = ?',
            [videoId, userId], function (err) {
                if (err) {
                    console.error('Error setting current video:', err);
                    return res.status(500).json({ error: 'Database error' });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Video not found' });
                }

                res.json({ message: 'Current video updated successfully' });
            });
    });
});

app.get('/api/current-video', authenticateToken, (req, res) => {
    const userId = req.user.id;

    db.get('SELECT * FROM videos WHERE user_id = ? AND is_current = 1',
        [userId], (err, video) => {
            if (err) {
                console.error('Error fetching current video:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            if (!video) {
                return res.status(404).json({ error: 'No current video set' });
            }

            res.json(video);
        });
});

app.delete('/api/videos/:id', authenticateToken, (req, res) => {
    const videoId = req.params.id;
    const userId = req.user.id;

    db.get('SELECT * FROM videos WHERE id = ? AND user_id = ?',
        [videoId, userId], (err, video) => {
            if (err) {
                console.error('Error finding video:', err);
                return res.status(500).json({ error: 'Database error' });
            }

            if (!video) {
                return res.status(404).json({ error: 'Video not found' });
            }


            try {
                if (fs.existsSync(video.path)) {
                    fs.unlinkSync(video.path);
                }
            } catch (fileErr) {
                console.error('Error deleting video file:', fileErr);
            }


            db.run('DELETE FROM videos WHERE id = ? AND user_id = ?',
                [videoId, userId], function (err) {
                    if (err) {
                        console.error('Error deleting video from database:', err);
                        return res.status(500).json({ error: 'Database error' });
                    }

                    res.json({ message: 'Video deleted successfully' });
                });
        });
});
app.get('/api/zones-with-capacity', async (req, res) => {
    try {
        const cameraId = req.query.camera_id || 1;

        const zones = await dbQuery(`
            SELECT id, name, coordinates, camera_id, user_id, created_at,
                   capacity_limit, warning_threshold, alert_color,
                   video_width, video_height
            FROM zones 
            WHERE camera_id = ?
            ORDER BY created_at DESC
        `, [cameraId]);

        const processedZones = zones.map(zone => {
            try {
                return {
                    ...zone,
                    coordinates: JSON.parse(zone.coordinates || '[]'),
                    capacity_limit: zone.capacity_limit || 50,
                    warning_threshold: zone.warning_threshold || 40,
                    alert_color: zone.alert_color || '#4ecdc4',
                    has_dimensions: !!(zone.video_width && zone.video_height)
                };
            } catch (e) {
                console.error('Error parsing zone coordinates:', e);
                return null;
            }
        }).filter(zone => zone !== null);

        console.log(`Returning ${processedZones.length} real zones for camera ${cameraId}`);

        res.json(processedZones);
    } catch (error) {
        console.error('Error fetching zones with capacity:', error);
        res.status(500).json({
            error: 'Failed to fetch zones',
            data_source: 'error'
        });
    }
});



app.post('/api/zones-with-capacity', async (req, res) => {
    try {
        const { name, coordinates, camera_id, capacity_limit, warning_threshold, alert_color } = req.body;
        const user_id = req.user ? req.user.id : 1;

        if (!name || !coordinates || !camera_id) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await dbRun(`
            INSERT INTO zones (name, coordinates, camera_id, user_id, capacity_limit, warning_threshold, alert_color)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            name,
            JSON.stringify(coordinates),
            camera_id,
            user_id,
            capacity_limit || 50,
            warning_threshold || 40,
            alert_color || '#4ecdc4'
        ]);

        res.json({
            success: true,
            zone: {
                id: result.id,
                name,
                capacity_limit: capacity_limit || 50,
                warning_threshold: warning_threshold || 40
            }
        });
    } catch (error) {
        console.error('Error creating zone with capacity:', error);
        res.status(500).json({ error: 'Failed to create zone' });
    }
});


app.put('/api/zones/:id/capacity', async (req, res) => {
    try {
        const { id } = req.params;
        const { capacity_limit, warning_threshold, alert_color } = req.body;

        await dbRun(`
            UPDATE zones 
            SET capacity_limit = ?, warning_threshold = ?, alert_color = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [capacity_limit, warning_threshold, alert_color, id]);

        res.json({ success: true, message: 'Zone capacity updated successfully' });
    } catch (error) {
        console.error('Error updating zone capacity:', error);
        res.status(500).json({ error: 'Failed to update zone capacity' });
    }
});


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

            console.log(`Returning real analytics data: ${timeline.length} data points`);

            res.json({
                timeline,
                zones,
                range,
                start_time: startTime.toISOString(),
                end_time: now.toISOString(),
                data_source: 'real'
            });
        } else {
            console.log('No real analytics data found, returning empty dataset');
            res.json({
                timeline: [],
                zones: {},
                range,
                start_time: startTime.toISOString(),
                end_time: now.toISOString(),
                data_source: 'empty',
                message: 'No data available for this time range. Start YOLO processing to generate data.'
            });
        }
    } catch (error) {
        console.error('Error fetching real analytics data:', error);
        res.status(500).json({
            error: 'Failed to fetch analytics data',
            data_source: 'error',
            message: 'Database error occurred'
        });
    }
});

app.post('/api/analytics-data', async (req, res) => {
    try {
        const data = req.body;
        console.log('Analytics data received via HTTP:', data);


        await storeCameraAnalytics(data);


        io.emit('live_analytics_data', data);
        io.emit('live_camera_data', {
            camera_id: data.camera_id,
            total_count: data.total_people,
            zone_counts: Object.fromEntries(
                Object.entries(data.zones || {}).map(([name, zoneData]) => [name, zoneData.count])
            ),
            fps: data.performance?.fps || 0,
            processing_time: data.performance?.processing_time || 0,
            timestamp: data.timestamp
        });

        console.log('Analytics data broadcasted to all clients');
        res.json({ success: true, message: 'Analytics data processed' });

    } catch (error) {
        console.error('Error processing analytics data via HTTP:', error);
        res.status(500).json({ error: 'Failed to process analytics data' });
    }
});

app.get('/api/capacity-violations', async (req, res) => {
    try {
        const recent = req.query.recent === 'true';
        const cameraId = req.query.camera_id;
        const limit = parseInt(req.query.limit) || 50;

        let query = `
            SELECT cv.*, z.name as zone_name
            FROM capacity_violations cv
            LEFT JOIN zones z ON cv.zone_id = z.id
            WHERE 1=1
        `;
        let params = [];

        if (recent) {

            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
            query += ` AND cv.violation_start >= ?`;
            params.push(yesterday.toISOString());
        }

        if (cameraId) {
            query += ` AND cv.camera_id = ?`;
            params.push(cameraId);
        }

        query += ` ORDER BY cv.violation_start DESC LIMIT ?`;
        params.push(limit);

        const violations = await dbQuery(query, params);

        res.json(violations);
    } catch (error) {
        console.error('Error fetching capacity violations:', error);
        res.status(500).json({ error: 'Failed to fetch capacity violations' });
    }
});

app.post('/api/capacity-violations', authenticateToken, async (req, res) => {
    try {
        const violation = req.body;


        if (!violation.zone_name || !violation.camera_id) {
            return res.status(400).json({
                error: 'Missing required fields: zone_name and camera_id are required'
            });
        }

        const result = await storeCapacityViolation(violation);

        if (result.success) {

            io.emit('capacity_violation_alert', {
                ...violation,
                id: result.id,
                timestamp: new Date().toISOString()
            });

            res.json({
                success: true,
                message: 'Capacity violation stored successfully',
                violation_id: result.id
            });
        } else {
            res.status(500).json({
                error: 'Failed to store capacity violation',
                details: result.error
            });
        }

    } catch (error) {
        console.error('Error in capacity violation API:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});


app.get('/api/zone-analytics', async (req, res) => {
    try {
        const range = req.query.range || '24h';
        const zoneId = req.query.zone_id;
        const cameraId = req.query.camera_id;


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
            case '7d':
                startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            default:
                startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        }

        let query = `
            SELECT za.*, z.name as zone_name, z.capacity_limit, z.warning_threshold
            FROM zone_analytics za
            JOIN zones z ON za.zone_id = z.id
            WHERE za.timestamp >= ?
        `;
        let params = [startTime.toISOString()];

        if (zoneId) {
            query += ` AND za.zone_id = ?`;
            params.push(zoneId);
        }

        if (cameraId) {
            query += ` AND za.camera_id = ?`;
            params.push(cameraId);
        }

        query += ` ORDER BY za.timestamp ASC`;

        const analytics = await dbQuery(query, params);


        const zoneData = {};
        analytics.forEach(row => {
            const zoneName = row.zone_name;
            if (!zoneData[zoneName]) {
                zoneData[zoneName] = {
                    zone_id: row.zone_id,
                    zone_name: zoneName,
                    capacity_limit: row.capacity_limit,
                    warning_threshold: row.warning_threshold,
                    data_points: []
                };
            }

            zoneData[zoneName].data_points.push({
                timestamp: row.timestamp,
                people_count: row.people_count,
                capacity_utilization: row.capacity_utilization
            });
        });

        res.json({
            zones: zoneData,
            range,
            start_time: startTime.toISOString(),
            end_time: now.toISOString()
        });
    } catch (error) {
        console.error('Error fetching zone analytics:', error);
        res.status(500).json({ error: 'Failed to fetch zone analytics' });
    }
});


app.get('/api/analytics-summary', async (req, res) => {
    try {
        const cameraId = req.query.camera_id || 1;


        const latestData = await dbGet(`
            SELECT 
                total_count, 
                zone_counts, 
                fps, 
                timestamp,
                capacity_warnings,
                capacity_violations,
                processing_time
            FROM camera_data 
            WHERE camera_id = ?
            ORDER BY timestamp DESC 
            LIMIT 1
        `, [cameraId]);

        const zones = await dbQuery(`
            SELECT id, name, capacity_limit, warning_threshold, alert_color
            FROM zones 
            WHERE camera_id = ?
        `, [cameraId]);

        let currentZoneCounts = {};
        if (latestData && latestData.zone_counts) {
            try {
                currentZoneCounts = JSON.parse(latestData.zone_counts);
            } catch (e) {
                console.error('Error parsing zone counts:', e);
            }
        }


        let zonesAtWarning = 0;
        let zonesAtCapacity = 0;
        const zoneStatus = {};

        zones.forEach(zone => {
            const currentCount = currentZoneCounts[zone.name] || 0;
            const utilization = zone.capacity_limit > 0 ? (currentCount / zone.capacity_limit) * 100 : 0;

            zoneStatus[zone.name] = {
                current_count: currentCount,
                capacity_limit: zone.capacity_limit,
                warning_threshold: zone.warning_threshold,
                utilization: utilization,
                status: utilization >= 100 ? 'exceeded' : utilization >= 80 ? 'warning' : 'normal'
            };

            if (utilization >= 100) zonesAtCapacity++;
            else if (utilization >= 80) zonesAtWarning++;
        });

        const summary = {
            camera_id: cameraId,
            total_people: latestData ? latestData.total_count : 0,
            zones_at_capacity: zonesAtCapacity,
            zones_at_warning: zonesAtWarning,
            peak_occupancy: latestData ? latestData.total_count : 0,
            avg_occupancy: latestData ? latestData.total_count : 0,
            fps: latestData ? latestData.fps : 0,
            processing_time: latestData ? latestData.processing_time : 0,
            timestamp: latestData ? latestData.timestamp : new Date().toISOString()
        };

        res.json({
            summary,
            current_data: {
                total_count: latestData ? latestData.total_count : 0,
                zone_counts: currentZoneCounts,
                fps: latestData ? latestData.fps : 0,
                timestamp: latestData ? latestData.timestamp : null,
                zones_at_warning: zonesAtWarning,
                zones_at_capacity: zonesAtCapacity
            },
            zone_status: zoneStatus,
            last_updated: new Date().toISOString(),
            data_source: latestData ? 'real' : 'empty'
        });

    } catch (error) {
        console.error('Error fetching analytics summary:', error);
        res.status(500).json({ error: 'Failed to fetch analytics summary' });
    }
});

app.post('/api/analytics/save-violation', async (req, res) => {
    try {
        const {
            zone_id,
            camera_id,
            zone_name,
            people_count,
            capacity_limit,
            violation_type,
            violation_start
        } = req.body;

        if (!zone_id || !camera_id || !zone_name || !violation_type) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await dbRun(`
            INSERT INTO capacity_violations 
            (zone_id, camera_id, zone_name, people_count, capacity_limit, violation_type, violation_start)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [zone_id, camera_id, zone_name, people_count, capacity_limit, violation_type, violation_start]);


        if (req.io) {
            req.io.emit('capacity_violation', {
                id: result.id,
                zone_id,
                camera_id,
                zone_name,
                people_count,
                capacity_limit,
                violation_type,
                violation_start
            });
        }

        res.json({ success: true, violation_id: result.id });
    } catch (error) {
        console.error('Error saving capacity violation:', error);
        res.status(500).json({ error: 'Failed to save capacity violation' });
    }
});


app.get('/api/peak-hours', async (req, res) => {
    try {
        const cameraId = req.query.camera_id || 1;
        const days = parseInt(req.query.days) || 7;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const peakHours = await dbQuery(`
            SELECT 
                hour_of_day,
                AVG(peak_occupancy) as avg_peak_occupancy,
                MAX(peak_occupancy) as max_peak_occupancy,
                COUNT(*) as day_count
            FROM analytics_summary 
            WHERE camera_id = ? AND date_recorded >= ?
            GROUP BY hour_of_day
            ORDER BY hour_of_day
        `, [cameraId, startDate.toISOString().split('T')[0]]);

        res.json({
            peak_hours: peakHours,
            analysis_period: `${days} days`,
            camera_id: cameraId
        });
    } catch (error) {
        console.error('Error fetching peak hours:', error);
        res.status(500).json({ error: 'Failed to fetch peak hours analysis' });
    }
});


app.get('/api/capacity-reports', async (req, res) => {
    try {
        const cameraId = req.query.camera_id || 1;
        const range = req.query.range || '7d';


        const now = new Date();
        let startDate;

        switch (range) {
            case '24h':
                startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            case '7d':
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30d':
                startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            default:
                startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }


        const utilizationData = await dbQuery(`
            SELECT 
                z.name as zone_name,
                z.capacity_limit,
                AVG(za.capacity_utilization) as avg_utilization,
                MAX(za.capacity_utilization) as peak_utilization,
                COUNT(CASE WHEN za.capacity_utilization >= 80 THEN 1 END) as warning_periods,
                COUNT(CASE WHEN za.capacity_utilization >= 100 THEN 1 END) as exceeded_periods,
                COUNT(*) as total_periods
            FROM zone_analytics za
            JOIN zones z ON za.zone_id = z.id
            WHERE za.camera_id = ? AND za.timestamp >= ?
            GROUP BY z.id, z.name, z.capacity_limit
            ORDER BY avg_utilization DESC
        `, [cameraId, startDate.toISOString()]);


        const violationSummary = await dbQuery(`
            SELECT 
                zone_name,
                violation_type,
                COUNT(*) as violation_count,
                AVG(duration_seconds) as avg_duration,
                SUM(duration_seconds) as total_duration
            FROM capacity_violations
            WHERE camera_id = ? AND violation_start >= ?
            GROUP BY zone_name, violation_type
            ORDER BY violation_count DESC
        `, [cameraId, startDate.toISOString()]);

        res.json({
            utilization_data: utilizationData,
            violation_summary: violationSummary,
            report_range: range,
            start_date: startDate.toISOString(),
            end_date: now.toISOString(),
            camera_id: cameraId
        });
    } catch (error) {
        console.error('Error generating capacity reports:', error);
        res.status(500).json({ error: 'Failed to generate capacity reports' });
    }
});

app.get('/api/processing-status', (req, res) => {
    const statusArray = Array.from(processStatus.entries()).map(([cameraId, status]) => ({
        cameraId,
        ...status
    }));

    res.json(statusArray);
});

app.get('/api/processing-status/:cameraId', (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    const status = processStatus.get(cameraId);

    if (!status) {
        return res.status(404).json({ error: 'No processing status found for this camera' });
    }

    res.json({ cameraId, ...status });
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/employee-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/employee-dashboard.html'));
});


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

const PORT = process.env.PORT || 7000;


function startServer(port) {
    const serverInstance = server.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
        console.log(`WebSocket server ready for real-time communication`);
        console.log(`Camera data API available at /api/camera-data`);
        console.log(`Video upload available at /api/upload-video`);
        console.log(`YOLO control API available at /api/start-yolo and /api/stop-yolo`);
        console.log(`\nPress Ctrl+C to stop the server gracefully`);
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
        console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

        if (yoloProcesses.size > 0) {
            console.log('Stopping YOLO processes...');
            yoloProcesses.forEach((process, cameraId) => {
                console.log(`Stopping YOLO process for camera ${cameraId}`);
                try {
                    process.kill('SIGTERM');
                } catch (error) {
                    console.error(`Error stopping YOLO process ${cameraId}:`, error);
                }
            });

            setTimeout(() => {
                yoloProcesses.forEach((process, cameraId) => {
                    if (!process.killed) {
                        console.log(`Force killing YOLO process for camera ${cameraId}`);
                        try {
                            process.kill('SIGKILL');
                        } catch (error) {
                            console.error(`Error force killing YOLO process ${cameraId}:`, error);
                        }
                    }
                });
            }, 3000);
        }


        if (io) {
            io.close(() => {
                console.log('WebSocket connections closed');
            });
        }
        if (serverInstance) {
            serverInstance.close((err) => {
                if (err) {
                    console.error('Error during server shutdown:', err);
                }
                console.log('HTTP server closed');


                if (db) {
                    db.close((err) => {
                        if (err) {
                            console.error('Error closing database:', err);
                        } else {
                            console.log('Database connection closed');
                        }
                        console.log('Graceful shutdown completed');
                        process.exit(0);
                    });
                } else {
                    process.exit(0);
                }
            });
        }


        setTimeout(() => {
            console.log('Forcing shutdown after timeout');
            process.exit(1);
        }, 10000);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err);
        gracefulShutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        gracefulShutdown('unhandledRejection');
    });
}


startServer(PORT);