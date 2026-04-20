const botEngineService = require('./services/bot-engine.service');

async function test() {
    console.log('Testing BotEngineService...');
    try {
        const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        const move = await botEngineService.getBestMove(fen, 10);
        console.log('Best Move found:', move);
        if (move && move.from && move.to) {
            console.log('SUCCESS: BotEngine is working!');
        } else {
            console.log('FAILED: No move returned');
        }
    } catch (err) {
        console.error('ERROR:', err);
    }
}

test();
