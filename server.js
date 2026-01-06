const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Setup Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*", // Erlaubt alle Verbindungen (für Dev/Netlify)
        methods: ["GET", "POST"]
    }
});

// Hilfsfunktion: Extrahiert die ID aus einer YouTube URL
// Egal ob 'youtube.com/watch?v=XYZ' oder 'youtu.be/XYZ' oder nur 'XYZ'
function getYouTubeID(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    // Wenn eine URL erkannt wurde, gib die ID zurück, sonst nimm an, es ist schon die ID
    return (match && match[2].length === 11) ? match[2] : url;
}

// Speicher
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[Connect] User connected: ${socket.id}`);

    // User tritt Lobby bei
    socket.on('join_room', ({ room, username, color }) => {
        socket.join(room);
        
        // Initialisiere Raum, falls nicht vorhanden
        if (!rooms[room]) {
            console.log(`[Room] Neuer Raum erstellt: ${room}`);
            rooms[room] = {
                // WICHTIG: Ein Default-Video setzen, damit der Player nicht leer ist!
                // (Hier: Lofi Girl Radio als Test)
                currentVideo: "jfKfPfyJRdk", 
                videoState: { time: 0, playing: false },
                users: []
            };
        }

        // User zur Liste hinzufügen
        const user = { id: socket.id, username, color };
        rooms[room].users.push(user);

        // 1. Dem User den aktuellen Raum-Status senden (inkl. Video ID)
        socket.emit('joined_room', { 
            roomState: rooms[room] 
        });

        // 2. Allen anderen sagen, dass jemand Neues da ist
        socket.to(room).emit('user_joined', user);
        
        // 3. System-Nachricht im Chat
        io.to(room).emit('receive_message', {
            username: 'System',
            text: `${username} ist der Party beigetreten!`,
            color: '#888'
        });

        console.log(`[Join] ${username} in Raum ${room}. Video: ${rooms[room].currentVideo}`);
    });

    // Chat Nachrichten
    socket.on('send_message', (data) => {
        io.to(data.room).emit('receive_message', data);
    });

    // Video URL ändern
    socket.on('change_video', ({ room, videoId }) => {
        if (rooms[room]) {
            // ID säubern (falls User eine ganze URL pastet)
            const cleanId = getYouTubeID(videoId);

            console.log(`[Video] Ändere Video in Raum ${room} zu: ${cleanId}`);

            rooms[room].currentVideo = cleanId;
            rooms[room].videoState = { time: 0, playing: true }; // Auto-Play bei neuem Video
            
            // An ALLE im Raum senden (auch an den, der es geändert hat)
            io.to(room).emit('update_video', cleanId);
        }
    });

    // Video Sync (Play, Pause, Seek)
    socket.on('sync_action', ({ room, type, time }) => {
        if (rooms[room]) {
            // Server State updaten
            rooms[room].videoState.playing = (type === 'play');
            rooms[room].videoState.time = time;

            // Log zur Kontrolle (kann man später auskommentieren)
            // console.log(`[Sync] ${room}: ${type} bei ${time}`);

            // An alle ANDEREN im Raum senden
            socket.to(room).emit('sync_action', { type, time });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
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
                    console.log(`[Room] Raum ${roomCode} gelöscht (leer).`);
                }
                break; // User gefunden, Loop beenden
            }
        }
        console.log(`[Disconnect] User disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`--- Server läuft auf Port ${PORT} ---`);
});
