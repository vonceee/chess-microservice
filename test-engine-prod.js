const botEngineService = require('./services/bot-engine.service');

async function verifyStockfish() {
    console.log('----------------------------------------------------');
    console.log('DIAGNOSTIC: Verifying Stockfish Engine Status');
    console.log('----------------------------------------------------');
    
    try {
        console.log('[1/3] Initializing engine...');
        const startTime = Date.now();
        const engine = await botEngineService.ensureEngine();
        console.log(`[PASS] Engine initialized in ${Date.now() - startTime}ms`);

        console.log('[2/3] Requesting test move (FEN: Starting Position)...');
        const moveStartTime = Date.now();
        const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const move = await botEngineService.getBestMove(fen, 10);
        
        if (move && move.from && move.to) {
            console.log(`[PASS] Best Move found: ${move.from}${move.to} in ${Date.now() - moveStartTime}ms`);
        } else {
            console.error('[FAIL] Engine returned no move or invalid move format.');
            process.exit(1);
        }

        console.log('[3/3] Checking environment and memory...');
        const memUsage = process.memoryUsage();
        console.log(`[INFO] RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);
        console.log(`[INFO] Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
        console.log(`[INFO] Node Version: ${process.version}`);
        
        console.log('----------------------------------------------------');
        console.log('SUCCESS: Bot Engine is healthy and responding.');
        console.log('NOTE: Engine restart test was skipped as it is not');
        console.log('supported by this library version in a single process.');
        console.log('----------------------------------------------------');
        process.exit(0);

    } catch (err) {
        console.error('----------------------------------------------------');
        console.error('CRITICAL FAILURE: Stockfish engine is not working.');
        console.error('Error Details:', err);
        console.error('Possible Causes:');
        console.error('1. System memory limits reached (common on Render free tier)');
        console.error('2. Package binary/WASM incompatibility with the OS');
        console.error('3. Port or threading issues in the environment');
        console.error('----------------------------------------------------');
        process.exit(1);
    }
}

verifyStockfish();
