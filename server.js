const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Setup Socket.IO mit CORS Erlaubnis für Netlify/Localhost
const io = new Server(server, {
    cors: {
        origin: "*", // Für Production: Hier später die Netlify URL eintragen
        methods: ["GET", "POST"]
    }
});

// In-Memory Speicher (Für MVP okay, bei Skalierung Redis nutzen)
const rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User tritt Lobby bei
    socket.on('join_room', ({ room, username, color }) => {
        socket.join(room);
        
        // Initialisiere Raum, falls nicht vorhanden
        if (!rooms[room]) {
            rooms[room] = {
                currentVideo: null, // YouTube Video ID
                videoState: { time: 0, playing: false },
                users: []
            };
        }

        // User zur Liste hinzufügen
        const user = { id: socket.id, username, color };
        rooms[room].users.push(user);

        // Bestätigung an den User senden
        socket.emit('joined_room', { 
            roomState: rooms[room] 
        });

        // Alle anderen im Raum benachrichtigen
        socket.to(room).emit('user_joined', user);
        
        // Chat Nachricht vom System
        io.to(room).emit('receive_message', {
            username: 'System',
            text: `${username} ist der Party beigetreten!`,
            color: '#888'
        });
    });

    // Chat Nachrichten
    socket.on('send_message', (data) => {
        io.to(data.room).emit('receive_message', data);
    });

    // Video URL ändern
    socket.on('change_video', ({ room, videoId }) => {
        if (rooms[room]) {
            rooms[room].currentVideo = videoId;
            rooms[room].videoState = { time: 0, playing: true };
            io.to(room).emit('update_video', videoId);
        }
    });

    // Video Sync (Play, Pause, Seek)
    socket.on('sync_action', ({ room, type, time }) => {
        if (rooms[room]) {
            // Server State updaten
            rooms[room].videoState.playing = (type === 'play');
            rooms[room].videoState.time = time;

            // An alle ANDEREN im Raum senden (damit der Sender nicht springt)
            socket.to(room).emit('sync_action', { type, time });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        // User aus allen Räumen entfernen
        for (const roomCode in rooms) {
            const index = rooms[roomCode].users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                const user = rooms[roomCode].users[index];
                rooms[roomCode].users.splice(index, 1);
                
                io.to(roomCode).emit('user_left', user.id);
                io.to(roomCode).emit('receive_message', {
                    username: 'System',
                    text: `${user.username} hat die Party verlassen.`,
                    color: '#888'
                });

                // Raum löschen wenn leer
                if (rooms[roomCode].users.length === 0) {
                    delete rooms[roomCode];
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
