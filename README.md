# Dama: online two-player Filipino checkers

Node.js + WebSockets + MySQL. Two people on two devices play in real time.

## Run it

1. Install Node 18+ and MySQL 8 (or MariaDB 10.5+).
2. Create the database: `mysql -u root -p < schema.sql`
3. `cp .env.example .env` and fill in your MySQL password and a random `JWT_SECRET`.
4. `npm install`
5. `npm start`, then open http://localhost:3000
6. To test alone, open a second browser or a private window, create a second account, and click **Find a match** in both.

## Features

- Accounts: register and log in (bcrypt passwords, JWT sessions). Stats are saved per player.
- Leaderboard ranked by ELO rating (everyone starts at 1200, K = 32).
- Match history with step-by-step replay (every move is stored in `game_moves`).
- In-game chat, saved with the game.
- Turn timer (`TURN_SECONDS`, default 60). Running out of time on your turn loses the game.
- Draw offers and undo requests. The opponent must accept. Undo takes back your own last move.
- Rules: forced capture, must take the route that captures the most chips, flying dama (king).
- Rejoin: refresh, switch devices or lose connection and you land back in your game. Your clock keeps running while you are away. Unfinished games also survive a server restart.

## Rules implemented

8x8 board, 12 chips each on the dark squares, white moves first. Men step diagonally forward and capture in all four directions. Reaching the far row at the end of a move makes a dama, which moves and captures any distance diagonally. Captured chips are removed after the whole sequence and can't be jumped twice. A player with no legal move loses. 40 plies without a capture or man move is a draw. Dama has regional variations, so the shared rules live in one file (`public/dama.js`) that is easy to adjust.

## Files

- `server.js`: REST API, WebSocket game manager, timers, ELO, MySQL
- `public/dama.js`: rules engine, used by both server (authoritative) and browser
- `public/index.html`: the whole client
- `schema.sql`: tables for users, games, moves, chat
