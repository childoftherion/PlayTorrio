/**
 * Torrent Engine Routes - Unified API routes for all torrent engines
 * Engine provides raw stream, player's transcoder handles the rest
 */

import * as EngineManager from './torrent_engine_manager.mjs';
import mime from 'mime-types';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Store paths
let userDataPath = null;

/**
 * Get temp directory for torrent cache
 */
function getTempDir() {
    const tempBase = process.env.TEMP || process.env.TMP || os.tmpdir();
    return path.join(tempBase, 'playtorrio-stream');
}

/**
 * Register all torrent engine routes
 */
export function registerTorrentEngineRoutes(app, dataPath) {
    userDataPath = dataPath;
    
    // Initialize the engine manager
    EngineManager.initialize(dataPath);
    
    // Start the configured engine
    EngineManager.startEngine().then(() => {
        console.log('[TorrentEngineRoutes] Engine started');
    }).catch(err => {
        console.error('[TorrentEngineRoutes] Failed to start engine:', err.message);
    });

    // ============================================================================
    // ENGINE CONFIGURATION
    // ============================================================================
    
    app.get('/api/torrent-engine/config', (req, res) => {
        res.json(EngineManager.getEngineConfig());
    });

    app.post('/api/torrent-engine/config', async (req, res) => {
        try {
            const { engine, instances } = req.body;
            const result = await EngineManager.setEngine(engine, instances);
            await EngineManager.startEngine();
            res.json(result);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    app.get('/api/torrent-engine/status', (req, res) => {
        res.json(EngineManager.getStatus());
    });

    // ============================================================================
    // TORRENT FILES API
    // ============================================================================
    
    app.get('/api/alt-torrent-files', async (req, res) => {
        try {
            const { magnet } = req.query;
            if (!magnet) return res.status(400).json({ error: 'Missing magnet' });
            
            const config = EngineManager.getEngineConfig();
            if (config.engine === 'stremio') {
                return res.status(400).json({ error: 'Use /api/torrent-files for Stremio engine' });
            }
            
            if (!EngineManager.isEngineReady()) {
                await EngineManager.startEngine();
            }
            
            console.log(`[TorrentEngineRoutes] Getting files via ${config.engine}: ${magnet.substring(0, 60)}...`);
            const result = await EngineManager.getTorrentFiles(magnet);
            res.json(result);
        } catch (error) {
            console.error('[TorrentEngineRoutes] Get files error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // ============================================================================
    // STREAMING API - Raw stream for player's transcoder
    // ============================================================================

    /**
     * Stream file - provides raw torrent stream
     * Player's transcoder handles transcoding, duration, seeking, etc.
     * Supports byte range requests for seeking
     */
    app.get('/api/alt-stream-file', async (req, res) => {
        let inputStream = null;
        
        const cleanup = () => {
            try { if (inputStream) inputStream.destroy(); } catch (e) {}
            inputStream = null;
        };
        
        try {
            let { hash, file: fileIndex } = req.query;
            if (!hash || fileIndex === undefined) {
                return res.status(400).json({ error: 'Missing hash or file index' });
            }
            
            hash = hash.toLowerCase();
            
            const config = EngineManager.getEngineConfig();
            if (config.engine === 'stremio') {
                return res.status(400).json({ error: 'Use /api/stream-file for Stremio engine' });
            }
            
            if (!EngineManager.isEngineReady()) {
                return res.status(503).json({ error: 'Engine not ready' });
            }
            
            const file = EngineManager.getFile(hash, Number(fileIndex));
            if (!file) {
                return res.status(404).json({ error: 'File not found' });
            }
            
            const fileName = file.name || 'video.mkv';
            const fileSize = file.length;
            const mimeType = mime.lookup(fileName) || 'video/x-matroska';
            
            res.on('close', cleanup);
            res.on('error', cleanup);
            
            // Handle range requests for seeking
            const range = req.headers.range;
            
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const rangeStart = parseInt(parts[0], 10);
                const rangeEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = rangeEnd - rangeStart + 1;
                
                // Only log significant range requests (not every chunk)
                if (rangeStart === 0 || rangeStart > 1024 * 1024) {
                    console.log(`[TorrentEngineRoutes] Stream: ${fileName.substring(0, 40)}... Range: ${(rangeStart/1024/1024).toFixed(1)}MB-${(rangeEnd/1024/1024).toFixed(1)}MB`);
                }
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': mimeType,
                    'Access-Control-Allow-Origin': '*',
                });
                
                inputStream = EngineManager.getFileStream(hash, Number(fileIndex), { start: rangeStart, end: rangeEnd });
            } else {
                console.log(`[TorrentEngineRoutes] Stream: ${fileName.substring(0, 40)}... Full file (${(fileSize/1024/1024).toFixed(1)}MB)`);
                
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': mimeType,
                    'Accept-Ranges': 'bytes',
                    'Access-Control-Allow-Origin': '*',
                });
                
                inputStream = EngineManager.getFileStream(hash, Number(fileIndex));
            }
            
            if (!inputStream) {
                return res.status(500).json({ error: 'Failed to get file stream' });
            }
            
            inputStream.on('error', (err) => {
                if (!err.message?.includes('aborted')) {
                    console.error('[TorrentEngineRoutes] Stream error:', err.message);
                }
                cleanup();
            });
            
            inputStream.pipe(res).on('error', () => {});
            
        } catch (error) {
            console.error('[TorrentEngineRoutes] Stream error:', error.message);
            cleanup();
            if (!res.headersSent) {
                res.status(500).json({ error: error.message });
            }
        }
    });

    /**
     * Get basic file info
     */
    app.get('/api/alt-stream-metadata', async (req, res) => {
        try {
            let { hash, file: fileIndex } = req.query;
            if (!hash || fileIndex === undefined) {
                return res.status(400).json({ error: 'Missing params' });
            }
            
            hash = hash.toLowerCase();
            
            const file = EngineManager.getFile(hash, Number(fileIndex));
            if (!file) {
                return res.status(404).json({ error: 'File not found' });
            }
            
            res.json({
                fileName: file.name,
                fileSize: file.length,
            });
            
        } catch (error) {
            console.error('[TorrentEngineRoutes] Metadata error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * Prepare file for streaming
     */
    app.get('/api/alt-prepare-file', async (req, res) => {
        try {
            let { hash, file: fileIndex } = req.query;
            if (!hash || fileIndex === undefined) {
                return res.status(400).json({ success: false, error: 'Missing params' });
            }
            
            hash = hash.toLowerCase();
            
            res.json({
                success: true,
                infoHash: hash,
                streamUrl: `/api/alt-stream-file?hash=${hash}&file=${fileIndex}`,
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Stop stream / remove torrent
     */
    app.get('/api/alt-stop-stream', async (req, res) => {
        try {
            let { hash } = req.query;
            if (!hash) return res.status(400).json({ error: 'Missing hash' });
            
            hash = hash.toLowerCase();
            
            console.log(`[TorrentEngineRoutes] Stopping: ${hash.substring(0, 8)}...`);
            await EngineManager.removeTorrent(hash);
            
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    /**
     * Get torrent stats
     */
    app.get('/api/alt-torrent-stats', async (req, res) => {
        try {
            let { hash } = req.query;
            if (!hash) return res.status(400).json({ error: 'Missing hash' });
            
            hash = hash.toLowerCase();
            const stats = EngineManager.getStats(hash);
            res.json(stats || { error: 'Not found' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * Get engine status
     */
    app.get('/api/alt-engine-status', async (req, res) => {
        try {
            res.json(EngineManager.getStatus());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Cleanup function
    return {
        cleanup: async () => {
            console.log('[TorrentEngineRoutes] Cleaning up...');
            
            // Clean temp directory if it exists
            try {
                const tempDir = getTempDir();
                if (fs.existsSync(tempDir)) {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            } catch (e) {}
            
            await EngineManager.stopEngine();
        },
    };
}

export default { registerTorrentEngineRoutes };
