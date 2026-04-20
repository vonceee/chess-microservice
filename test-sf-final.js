const stockfish = require('stockfish');

async function test() {
    // The index.js of 'stockfish' package is:
    // function initEngine(enginePath, cb) { ... }
    
    const engine = await stockfish();
    
    // Test if we can catch output
    engine.print = (line) => {
        console.log('>>> CAPTURED:', line);
    };
    
    engine.sendCommand('uci');
    
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

test();
