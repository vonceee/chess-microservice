# Chess Real-time Microservice

A Node.js/Socket.io service responsible for the authoritative game state and real-time communication of the VON.CHESS platform.

## Core Responsibilities

- **Authoritative Validation**: Validates all chess moves using `chess.js`.
- **Clock Management**: Manages Lichess-style clocks with millisecond precision and authoritative timeouts.
- **Real-time Broadcasts**: Handles Socket.io events for moves, chat, and game status.
- **Match Orchestration**: Receives commands from the Laravel backend to initialize new games.

## Logic Architecture

The project follows a modular architecture to separate concerns:

- **[`handlers/`](./handlers/)**: Handles Socket.io event routing.
  - `game.handler.js`: Move processing, resignations, draw offers, and rematches.
  - `arena.handler.js`: Tournament pairing and joining.
  - `tv.handler.js`: Chess TV broadcasts.
- **[`routes/`](./routes/)**: Handles HTTP endpoints for communication with the Laravel backend.
- **[`services/`](./services/)**: Holds unified business logic (e.g., `game-logic.js`) used by both routes and handlers.
- **[`utils/`](./utils/)**: Shared helper functions.
  - `chess.js`: Engine-specific logic.
  - `clock.js`: Timing and state sanitization.

## Communication with Laravel

- **Internal API**: Laravel calls `POST /api/create-game` to start a session.
- **Webhooks**: Node.js calls the Laravel internal API upon game completion to report authoritative results and update Elo.

## Setup

```bash
npm install
node server.js
```

## Environment Variables

| Variable | Description |
| :--- | :--- |
| `API_BASE_URL` | URL of the Laravel backend API |
| `INTERNAL_SECRET` | Shared secret for authoritative API calls |
| `PORT` | Listening port (default: 3006) |
