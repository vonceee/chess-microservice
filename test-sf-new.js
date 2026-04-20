const stockfish = require('stockfish');

async function test() {
    console.log('Starting Stockfish...');
    const engine = await stockfish();
    console.log('Engine initialized. Methods:', Object.keys(engine).filter(k => typeof engine[k] === 'function'));
    
    engine.addMessageListener((line) => {
        console.log('SF:', line);
    });
    
    engine.postMessage('uci');
}

test().catch(console.error);
