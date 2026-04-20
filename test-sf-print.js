const stockfish = require('stockfish');

async function test() {
    console.log('Initializing Stockfish...');
    
    // The initEngine function in stockfish/index.js allows us to pass a path or nothing.
    // It returns a promise that resolves to the engine object.
    const engine = await stockfish();
    
    // Standard Emscripten print override
    engine.print = (line) => {
        console.log('SF-OUT:', line);
    };

    console.log('Sending uci...');
    engine.sendCommand('uci');
    
    // Wait a bit for output
    setTimeout(() => {
        console.log('Done.');
        process.exit(0);
    }, 2000);
}

test().catch(console.error);
