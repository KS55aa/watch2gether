const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Socket.IO Konfiguration
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// === HILFSFUNKTIONEN ===

function getYouTubeID(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : url;
}

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// === DATENSPEICHER ===
const rooms = {};
const userSockets = new Map(); // Socket ID -> User Info

// === REST API ENDPOINTS ===

// Health Check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'WatchParty Server läuft',
        version: '2.0',
        timestamp: new Date().toISOString(),
        activeRooms: Object.keys(rooms).length,
        activeConnections: io.engine.clientsCount
    });
});

// Server Status
app.get('/api/status', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        rooms: Object.keys(rooms).length,
        connections: io.engine.clientsCount,
        memory: process.memoryUsage()
    });
});

// Room Info
app.get('/api/room/:code', (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const room = rooms[roomCode];
    
    if (!room) {
        return res.status(404).json({ error: 'Room nicht gefunden' });
    }
    
    res.json({
        code: roomCode,
        users: room.users.length,
        hasVideo: !!room.currentVideo,
        created: room.createdAt
    });
});

// === SOCKET.IO EVENTS ===

io.on('connection', (socket) => {
    console.log(`[${new Date().toLocaleTimeString()}] ✅ Neue Verbindung: ${socket.id}`);

    // User tritt Raum bei
    socket.on('join_room', ({ room, username, color }) => {
        try {
            const roomCode = room.toUpperCase();
            socket.join(roomCode);

            // Raum initialisieren falls nicht vorhanden
            if (!rooms[roomCode]) {
                rooms[roomCode] = {
                    code: roomCode,
                    currentVideo: null,
                    videoState: { 
                        time: 0, 
                        playing: false,
                        lastUpdate: Date.now()
                    },
                    users: [],
                    createdAt: new Date().toISOString()
                };
                console.log(`[${new Date().toLocaleTimeString()}] 🏠 Neuer Raum erstellt: ${roomCode}`);
            }

            // User Objekt erstellen
            const user = {
                id: socket.id,
                username: username.substring(0, 15), // Sicherheit: max 15 Zeichen
                color: color,
                joinedAt: new Date().toISOString()
            };

            // User zum Raum hinzufügen
            rooms[roomCode].users.push(user);
            userSockets.set(socket.id, { ...user, room: roomCode });

            // Dem User den aktuellen Raum-Status senden
            socket.emit('joined_room', {
                roomState: {
                    ...rooms[roomCode],
                    users: rooms[roomCode].users
                }
            });

            // Allen anderen im Raum mitteilen
            socket.to(roomCode).emit('user_joined', user);

            // System-Nachricht
            io.to(roomCode).emit('receive_message', {
                username: 'System',
                text: `${username} ist beigetreten 👋`,
                color: '#888',
                timestamp: Date.now()
            });

            console.log(`[${new Date().toLocaleTimeString()}] 👤 ${username} → Raum ${roomCode} (${rooms[roomCode].users.length} User)`);

        } catch (error) {
            console.error('Fehler beim Join:', error);
            socket.emit('error', { message: 'Fehler beim Beitreten' });
        }
    });

    // Chat Nachricht
    socket.on('send_message', (data) => {
        try {
            if (!data.text || data.text.trim().length === 0) return;
            
            const message = {
                username: data.username.substring(0, 15),
                text: data.text.substring(0, 500), // Sicherheit: max 500 Zeichen
                color: data.color,
                timestamp: Date.now()
            };

            io.to(data.room).emit('receive_message', message);
            console.log(`[${new Date().toLocaleTimeString()}] 💬 ${data.username}: ${data.text.substring(0, 50)}...`);

        } catch (error) {
            console.error('Fehler beim Senden der Nachricht:', error);
        }
    });

    // Video ändern
    socket.on('change_video', ({ room, videoId }) => {
        try {
            const roomCode = room.toUpperCase();
            
            if (!rooms[roomCode]) {
                socket.emit('error', { message: 'Raum nicht gefunden' });
                return;
            }

            const cleanId = getYouTubeID(videoId);
            
            if (!cleanId || cleanId.length !== 11) {
                socket.emit('error', { message: 'Ungültige Video ID' });
                return;
            }

            // Raum State updaten
            rooms[roomCode].currentVideo = cleanId;
            rooms[roomCode].videoState = {
                time: 0,
                playing: true,
                lastUpdate: Date.now()
            };

            // An ALLE im Raum senden
            io.to(roomCode).emit('update_video', cleanId);

            // System-Nachricht
            io.to(roomCode).emit('receive_message', {
                username: 'System',
                text: '📹 Neues Video wurde geladen',
                color: '#888',
                timestamp: Date.now()
            });

            console.log(`[${new Date().toLocaleTimeString()}] 📹 Video geändert in ${roomCode}: ${cleanId}`);

        } catch (error) {
            console.error('Fehler beim Video-Wechsel:', error);
            socket.emit('error', { message: 'Fehler beim Laden des Videos' });
        }
    });

    // Video Sync (Play/Pause/Seek)
    socket.on('sync_action', ({ room, type, time }) => {
        try {
            const roomCode = room.toUpperCase();
            
            if (!rooms[roomCode]) return;

            // Server State updaten
            rooms[roomCode].videoState = {
                playing: (type === 'play'),
                time: time,
                lastUpdate: Date.now()
            };

            // An alle ANDEREN im Raum senden
            socket.to(roomCode).emit('sync_action', {
                type: type,
                time: time,
                timestamp: Date.now()
            });

            // Log für wichtige Aktionen
            if (type === 'play' || type === 'pause') {
                console.log(`[${new Date().toLocaleTimeString()}] 🔄 ${roomCode}: ${type} @ ${Math.floor(time)}s`);
            }

        } catch (error) {
            console.error('Fehler beim Sync:', error);
        }
    });

    // Disconnect Handler
    socket.on('disconnect', (reason) => {
        try {
            const userInfo = userSockets.get(socket.id);
            
            if (userInfo) {
                const roomCode = userInfo.room;
                const room = rooms[roomCode];

                if (room) {
                    // User aus Liste entfernen
                    const index = room.users.findIndex(u => u.id === socket.id);
                    if (index !== -1) {
                        const user = room.users[index];
                        room.users.splice(index, 1);

                        // Anderen Usern mitteilen
                        socket.to(roomCode).emit('user_left', socket.id);
                        
                        io.to(roomCode).emit('receive_message', {
                            username: 'System',
                            text: `${user.username} hat die Lobby verlassen 👋`,
                            color: '#888',
                            timestamp: Date.now()
                        });

                        console.log(`[${new Date().toLocaleTimeString()}] 👋 ${user.username} verlässt ${roomCode} (${room.users.length} übrig)`);

                        // Raum löschen wenn leer
                        if (room.users.length === 0) {
                            delete rooms[roomCode];
                            console.log(`[${new Date().toLocaleTimeString()}] 🗑️  Raum ${roomCode} gelöscht (leer)`);
                        }
                    }
                }

                userSockets.delete(socket.id);
            }

            console.log(`[${new Date().toLocaleTimeString()}] ❌ Verbindung getrennt: ${socket.id} (${reason})`);

        } catch (error) {
            console.error('Fehler beim Disconnect:', error);
        }
    });

    // Error Handler
    socket.on('error', (error) => {
        console.error(`[${new Date().toLocaleTimeString()}] ⚠️  Socket Error:`, error);
    });
});

// === CLEANUP & MONITORING ===

// Räume älter als 24h ohne User löschen
setInterval(() => {
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;

    for (const [code, room] of Object.entries(rooms)) {
        const roomAge = now - new Date(room.createdAt).getTime();
        
        if (room.users.length === 0 && roomAge > dayInMs) {
            delete rooms[code];
            console.log(`[${new Date().toLocaleTimeString()}] 🧹 Alter leerer Raum gelöscht: ${code}`);
        }
    }
}, 60 * 60 * 1000); // Jede Stunde

// Server Status Log
setInterval(() => {
    console.log(`[${new Date().toLocaleTimeString()}] 📊 Status: ${Object.keys(rooms).length} Räume, ${io.engine.clientsCount} Verbindungen`);
}, 5 * 60 * 1000); // Alle 5 Minuten

// === SERVER START ===

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('\n========================================');
    console.log('🎬 WatchParty Server');
    console.log('========================================');
    console.log(`✅ Server läuft auf Port ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`📅 Gestartet: ${new Date().toLocaleString('de-DE')}`);
    console.log('========================================\n');
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM empfangen. Fahre Server herunter...');
    server.close(() => {
        console.log('✅ Server beendet');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT empfangen. Fahre Server herunter...');
    server.close(() => {
        console.log('✅ Server beendet');
        process.exit(0);
    });
});
