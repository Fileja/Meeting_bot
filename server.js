const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const TranscriptionWebSocketServer = require('./websocket-server');

const app = express();
const PORT = process.env.PORT || 3000;
const WS_PORT = process.env.WS_PORT || 9090;

// Initialize WebSocket server
const wsServer = new TranscriptionWebSocketServer(WS_PORT);
wsServer.start();

// Middleware
app.use(cors());
app.use(express.json());

// Store active sessions
const activeSessions = new Map();

// Ensure sessions directory exists
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/tmp/realtime-sessions';
fs.mkdir(SESSIONS_DIR, { recursive: true }).catch(console.error);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size
  });
});

// Start transcription session
app.post('/api/transcribe', async (req, res) => {
  try {
    const { meetingUrl, sessionId, language = 'en' } = req.body;
    
    if (!meetingUrl) {
      return res.status(400).json({ error: 'meetingUrl is required' });
    }

    const sessionIdToUse = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Check if session already exists
    if (activeSessions.has(sessionIdToUse)) {
      return res.status(409).json({ 
        error: 'Session already exists', 
        sessionId: sessionIdToUse 
      });
    }

    // Set environment variables for the session
    const env = {
      ...process.env,
      SESSION_ID: sessionIdToUse,
      LANG_CODE: language,
      MEETING_URL: meetingUrl
    };

    // Start the transcription session using the intern's existing script
    const sessionProcess = spawn('./create_session.sh', [meetingUrl], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: __dirname
    });

    let sessionData = {
      id: sessionIdToUse,
      meetingUrl,
      language,
      status: 'starting',
      startedAt: new Date().toISOString(),
      process: sessionProcess
    };

    activeSessions.set(sessionIdToUse, sessionData);

    // Handle process events
    sessionProcess.stdout.on('data', (data) => {
      console.log(`[${sessionIdToUse}] stdout:`, data.toString());
    });

    sessionProcess.stderr.on('data', (data) => {
      console.log(`[${sessionIdToUse}] stderr:`, data.toString());
    });

    sessionProcess.on('close', (code) => {
      console.log(`[${sessionIdToUse}] Process exited with code ${code}`);
      const session = activeSessions.get(sessionIdToUse);
      if (session) {
        session.status = code === 0 ? 'completed' : 'failed';
        session.endedAt = new Date().toISOString();
        session.exitCode = code;
      }
    });

    sessionProcess.on('error', (error) => {
      console.error(`[${sessionIdToUse}] Process error:`, error);
      const session = activeSessions.get(sessionIdToUse);
      if (session) {
        session.status = 'error';
        session.error = error.message;
        session.endedAt = new Date().toISOString();
      }
    });

    // Wait a bit to see if the session starts successfully
    setTimeout(() => {
      const session = activeSessions.get(sessionIdToUse);
      if (session && session.process && !session.process.killed) {
        session.status = 'active';
      }
    }, 5000);

    const wsUrl = `ws://${req.get('host').replace(/:\d+$/, '')}:${WS_PORT}?sessionId=${sessionIdToUse}`;
    
    res.json({
      success: true,
      sessionId: sessionIdToUse,
      status: 'starting',
      message: 'Transcription session started',
      websocketUrl: wsUrl,
      instructions: 'Connect to the WebSocket URL to receive real-time transcription data'
    });

  } catch (error) {
    console.error('Error starting transcription session:', error);
    res.status(500).json({ 
      error: 'Failed to start transcription session',
      details: error.message 
    });
  }
});

// Get session status
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId: session.id,
    meetingUrl: session.meetingUrl,
    language: session.language,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    error: session.error
  });
});

// Stop transcription session
app.post('/api/session/:sessionId/stop', async (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    if (session.process && !session.process.killed) {
      session.process.kill('SIGTERM');
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (session.process && !session.process.killed) {
          session.process.kill('SIGKILL');
        }
      }, 5000);
    }

    session.status = 'stopping';
    res.json({
      success: true,
      sessionId,
      status: 'stopping',
      message: 'Session stop requested'
    });

  } catch (error) {
    console.error('Error stopping session:', error);
    res.status(500).json({ 
      error: 'Failed to stop session',
      details: error.message 
    });
  }
});

// List all sessions
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.values()).map(session => ({
    sessionId: session.id,
    meetingUrl: session.meetingUrl,
    language: session.language,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    clientCount: wsServer.getClientCount(session.id)
  }));

  res.json({
    sessions,
    total: sessions.length
  });
});

// Get WebSocket connection info for a session
app.get('/api/session/:sessionId/websocket', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const wsUrl = `ws://${req.get('host').replace(/:\d+$/, '')}:${WS_PORT}?sessionId=${sessionId}`;
  
  res.json({
    sessionId,
    websocketUrl: wsUrl,
    clientCount: wsServer.getClientCount(sessionId),
    instructions: 'Connect to this WebSocket URL to receive real-time transcription data'
  });
});

// Clean up completed sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    // Remove sessions that ended more than 1 hour ago
    if (session.endedAt && (now - new Date(session.endedAt).getTime()) > 3600000) {
      activeSessions.delete(sessionId);
      console.log(`[CLEANUP] Removed old session: ${sessionId}`);
    }
  }
}, 300000); // Run every 5 minutes

// Start server
app.listen(PORT, () => {
      console.log(`Real-time transcription API server running on port ${PORT}`);
    console.log(`Sessions directory: ${SESSIONS_DIR}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
