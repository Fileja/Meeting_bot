const WebSocket = require('ws');
const http = require('http');

class TranscriptionWebSocketServer {
  constructor(port = 9090) {
    this.port = port;
    this.clients = new Map(); // sessionId -> Set of WebSocket connections
    this.server = null;
    this.wss = null;
  }

  start() {
    this.server = http.createServer();
    this.wss = new WebSocket.Server({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      console.log('[WS] New client connected');
      
      // Extract session ID from query parameters or headers
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId');
      
      if (!sessionId) {
        console.log('[WS] No sessionId provided, closing connection');
        ws.close(1008, 'sessionId required');
        return;
      }

      // Add client to session
      if (!this.clients.has(sessionId)) {
        this.clients.set(sessionId, new Set());
      }
      this.clients.get(sessionId).add(ws);

      console.log(`[WS] Client joined session: ${sessionId} (total: ${this.clients.get(sessionId).size})`);

      // Handle client disconnect
      ws.on('close', () => {
        if (this.clients.has(sessionId)) {
          this.clients.get(sessionId).delete(ws);
          if (this.clients.get(sessionId).size === 0) {
            this.clients.delete(sessionId);
            console.log(`[WS] Session ${sessionId} has no more clients`);
          }
        }
        console.log(`[WS] Client disconnected from session: ${sessionId}`);
      });

      // Handle client errors
      ws.on('error', (error) => {
        console.error(`[WS] Client error in session ${sessionId}:`, error);
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId: sessionId,
        timestamp: Date.now(),
        message: 'Connected to transcription stream'
      }));
    });

    this.server.listen(this.port, () => {
      console.log(`WebSocket server listening on port ${this.port}`);
    });

    return this;
  }

  // Broadcast transcription data to all clients in a session
  broadcastToSession(sessionId, data) {
    if (!this.clients.has(sessionId)) {
      return 0; // No clients for this session
    }

    const message = JSON.stringify(data);
    let sentCount = 0;

    this.clients.get(sessionId).forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          sentCount++;
        } catch (error) {
          console.error(`[WS] Error sending to client in session ${sessionId}:`, error);
        }
      }
    });

    return sentCount;
  }

  // Get client count for a session
  getClientCount(sessionId) {
    return this.clients.has(sessionId) ? this.clients.get(sessionId).size : 0;
  }

  // Get all active sessions
  getActiveSessions() {
    return Array.from(this.clients.keys());
  }

  // Stop the server
  stop() {
    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    console.log('[WS] WebSocket server stopped');
  }
}

// Export for use in other modules
module.exports = TranscriptionWebSocketServer;

// Start server if this file is run directly
if (require.main === module) {
  const server = new TranscriptionWebSocketServer();
  server.start();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[WS] Shutting down...');
    server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[WS] Shutting down...');
    server.stop();
    process.exit(0);
  });
}
