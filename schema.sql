-- Campus Room Reservation schema (MySQL 8.0+ / MariaDB 10.5+)
-- Creates structure only. No users, rooms, sections or bookings are inserted.
-- The database name is taken from DB_NAME in .env when the server starts.
CREATE DATABASE IF NOT EXISTS campusroom_reservation CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE campusroom_reservation;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  role ENUM('admin','teacher','student') NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rooms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  building VARCHAR(100) NOT NULL DEFAULT '',
  floor VARCHAR(20) NOT NULL DEFAULT '',
  capacity INT UNSIGNED NOT NULL DEFAULT 0,
  equipment VARCHAR(255) NOT NULL DEFAULT '',
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- A section (class) belongs to one teacher and one room, and has a join code for students.
CREATE TABLE IF NOT EXISTS classes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(120) NOT NULL,
  teacher_id INT UNSIGNED NOT NULL,
  room_id INT UNSIGNED NOT NULL,
  day_of_week TINYINT UNSIGNED NOT NULL COMMENT '1=Monday ... 7=Sunday',
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  join_code CHAR(8) NOT NULL UNIQUE,
  INDEX idx_classes_room (room_id, day_of_week),
  INDEX idx_classes_teacher (teacher_id),
  CONSTRAINT fk_classes_teacher FOREIGN KEY (teacher_id) REFERENCES users(id),
  CONSTRAINT fk_classes_room FOREIGN KEY (room_id) REFERENCES rooms(id)
) ENGINE=InnoDB;

-- Students who joined a section with its code.
CREATE TABLE IF NOT EXISTS enrollments (
  class_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, user_id),
  INDEX idx_enrollments_user (user_id),
  CONSTRAINT fk_enr_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  CONSTRAINT fk_enr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reservations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  class_id INT UNSIGNED NULL,
  title VARCHAR(150) NOT NULL,
  purpose TEXT,
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  decision_note VARCHAR(255) NOT NULL DEFAULT '',
  decided_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_res_room_date (room_id, booking_date, status),
  INDEX idx_res_user (user_id),
  CONSTRAINT fk_res_room FOREIGN KEY (room_id) REFERENCES rooms(id),
  CONSTRAINT fk_res_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_res_class FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL,
  CONSTRAINT fk_res_decider FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS announcements (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(150) NOT NULL,
  body TEXT NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ann_author FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  message VARCHAR(255) NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_user (user_id, is_read),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(50) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL
) ENGINE=InnoDB;
