CREATE DATABASE IF NOT EXISTS dama CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE dama;

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(24)  NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  rating        INT NOT NULL DEFAULT 1200,
  wins          INT NOT NULL DEFAULT 0,
  losses        INT NOT NULL DEFAULT 0,
  draws         INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rating (rating)
);

-- winner is NULL for a draw (when status = 'finished')
CREATE TABLE IF NOT EXISTS games (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  white_id    INT NOT NULL,
  black_id    INT NOT NULL,
  status      ENUM('active','finished') NOT NULL DEFAULT 'active',
  winner      ENUM('w','b') NULL,
  end_reason  VARCHAR(20) NULL,
  white_delta INT NULL,
  black_delta INT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at    TIMESTAMP NULL,
  INDEX idx_status (status),
  FOREIGN KEY (white_id) REFERENCES users(id),
  FOREIGN KEY (black_id) REFERENCES users(id)
);

-- One row per move; replaying these rows rebuilds the game (used for replays and rejoin after a restart)
CREATE TABLE IF NOT EXISTS game_moves (
  game_id INT NOT NULL,
  ply     INT NOT NULL,
  move    JSON NOT NULL,
  PRIMARY KEY (game_id, ply),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  game_id    INT NOT NULL,
  user_id    INT NOT NULL,
  message    VARCHAR(300) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_game (game_id),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);
