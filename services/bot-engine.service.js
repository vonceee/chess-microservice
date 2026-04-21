const stockfish = require('stockfish');
console.log('[Bootstrap] Stockfish module loaded successfully.');

/**
 * Service to handle bot move generation using Stockfish engine.
 */
class BotEngineService {
    constructor() {
        this.engine = null;
        this.isInitializing = false;
        this.initPromise = null;
        this.queue = [];
        this.isProcessing = false;
    }

    async ensureEngine() {
        if (this.engine) return this.engine;
        if (this.isInitializing) return this.initPromise;

        this.isInitializing = true;
        this.initPromise = new Promise(async (resolve, reject) => {
            try {
                console.log('[BotEngine] Initializing persistent engine (lite-single)...');
                const engine = await stockfish('lite-single');
                
                // Unified standard output listener
                engine.listener = (line) => {
                    const trimmed = line.trim();
                    if (trimmed && trimmed.startsWith('bestmove')) {
                        if (this.currentTask) {
                            console.log(`[BotEngine] Found move: ${trimmed}`);
                            this.handleTaskSuccess(trimmed);
                        }
                    }
                };
                engine.print = engine.listener;
                engine.onmessage = engine.listener;

                this.engine = engine;
                this.isInitializing = false;
                console.log('[BotEngine] Engine ready.');
                resolve(engine);
            } catch (err) {
                this.isInitializing = false;
                this.engine = null;
                console.error('[BotEngine] Failed to init engine:', err);
                reject(err);
            }
        });

        return this.initPromise;
    }

    /**
     * Entry point for requesting a move. Puts the request in a queue.
     */
    async getBestMove(fen, level = 10) {
        console.log(`[BotEngine] Requesting move for level ${level}. Queue length: ${this.queue.length}`);
        return new Promise((resolve) => {
            this.queue.push({ fen, level, resolve });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        
        this.currentTask = this.queue.shift();
        const { fen, level, resolve } = this.currentTask;

        try {
            const engine = await this.ensureEngine();
            
            // Set safety timeout for THIS specific move
            this.taskTimeout = setTimeout(() => {
                console.error('[BotEngine] Move calculation timed out.');
                this.handleTaskFailure('timeout');
            }, 12000);

            // Send UCI commands
            console.log(`[BotEngine] Calculating move for FEN: ${fen}`);
            engine.sendCommand('uci');
            engine.sendCommand(`setoption name Skill Level value ${level}`);
            engine.sendCommand('setoption name Hash value 16');
            engine.sendCommand('ucinewgame');
            engine.sendCommand(`position fen ${fen}`);
            
            const moveTime = this.calculateMoveTime(level);
            console.log(`[BotEngine] Sent 'go movetime ${moveTime}'`);
            engine.sendCommand(`go movetime ${moveTime}`);
            
        } catch (err) {
            console.error('[BotEngine] Queue processing error:', err);
            this.handleTaskFailure(err);
        }
    }

    handleTaskSuccess(uciLine) {
        if (!this.currentTask) return;
        clearTimeout(this.taskTimeout);
        
        const parts = uciLine.split(' ');
        const moveUci = parts[1];
        let move = null;

        if (moveUci && moveUci !== '(none)') {
            move = {
                from: moveUci.substring(0, 2),
                to: moveUci.substring(2, 4),
                promotion: moveUci.length > 4 ? moveUci.substring(4, 5) : null
            };
        }

        const resolve = this.currentTask.resolve;
        this.cleanupCurrentTask();
        resolve(move);
        
        // Process next in queue
        setTimeout(() => this.processQueue(), 50);
    }

    handleTaskFailure(error) {
        if (!this.currentTask) return;
        clearTimeout(this.taskTimeout);
        
        const resolve = this.currentTask.resolve;
        this.cleanupCurrentTask();
        resolve(null);
        
        // If we hit a critical error or repeated timeouts, restart engine
        if (error === 'timeout' || error.message?.includes('Aborted')) {
            this.restartEngine();
        }

        // Process next in queue
        setTimeout(() => this.processQueue(), 50);
    }

    cleanupCurrentTask() {
        this.currentTask = null;
        this.taskTimeout = null;
        this.isProcessing = false;
    }

    async restartEngine() {
        console.warn('[BotEngine] Attempting to restart Stockfish engine...');
        if (this.engine) {
            try { 
                // Some versions use terminate(), some don't. 
                if (typeof this.engine.terminate === 'function') this.engine.terminate(); 
            } catch (e) {
                console.error('[BotEngine] Error during termination:', e);
            }
            this.engine = null;
        }
        
        // Wait a bit before re-initializing to let the process clean up
        await new Promise(resolve => setTimeout(resolve, 500));
        
        return await this.ensureEngine();
    }

    calculateMoveTime(level) {
        if (level <= 5) return 300;
        if (level <= 10) return 600;
        if (level <= 15) return 1200;
        return 2000;
    }
}

module.exports = new BotEngineService();

