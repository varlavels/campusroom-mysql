# Campus Room Reservation (MySQL edition)

Front end: HTML, CSS and vanilla JavaScript in `public/`.
Server: Node.js (`server.js`) with the `mysql2` driver.
Database: MySQL 8 or MariaDB 10.5+. The database is named `campusroom_sections` in `.env` and is created empty on first start.

## Run it

1. Install Node.js 18 or newer, and make sure MySQL is running.
2. Check `.env`: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`. Only the server reads it.
3. In this folder run `npm install` (once), then `npm start`.
4. Open http://localhost:5055.
5. The first visit asks you to create the administrator (dean) account. Sign in as the administrator and set the campus name and booking hours on Settings. Add rooms on Rooms.

## How people get accounts

- Administrator: created on first setup. Can add teachers and students on People.
- Teacher: the administrator adds the teacher on People. Teachers create their own sections on My sections.
- Student: creates their own account. On the sign-in screen, choose "Create your account with a section code", enter the section code from the teacher, and choose a password. The student is placed in that section and sees only their own classes on the Home and My week pages. Their profile is at the top right, and the interface uses a light theme.

## How sections work

A section is a class with one teacher, one room, a day and a time. Each section has a join code. Teachers give the code to students and can make a new code at any time; the old code then stops working, and students already in the section keep their place. Teachers can see their section's student list.

When a teacher requests a room, they can attach it to one of their sections. The administrator sees the section on the request and is warned if the request clashes with an approved booking or a class. Students see only the rooms and times of their own sections.

## Roles

- Administrator (dean): approves or declines requests, cancels bookings, manages rooms, all sections, people, announcements and settings.
- Teacher: requests rooms, manages their own sections and join codes, sees their own bookings.
- Student: sees their week, room availability (taken or free, not who booked it), and announcements.

## Safety rules enforced on the server

- Passwords are stored as salted scrypt hashes. Sessions use random tokens stored as SHA-256 hashes in an HTTP-only cookie.
- Sign-in and sign-up are limited to a set number of attempts per 15 minutes per address.
- Every API route checks the caller's role.
- A booking is refused if it overlaps an approved booking or a scheduled section in the same room. Approval re-checks this inside a transaction, so two approvals cannot double-book a room.
- Bookings must fall within the campus opening hours and cannot be in the past.
- Students never see the join code of their section, and never see who booked a room.

## Production notes

- `.env` holds the root password, as set up for this project. For a live system, create a dedicated database user with rights only on `campusroom_sections`.
- Serve it over HTTPS before opening it to other people.
- Password reset by email, and email notifications, are not included yet.
