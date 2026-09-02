# LANtern Test Software

LANtern is a secure, local-area-network (LAN) exam administration and test-taking suite. Designed for Science Olympiad tryouts, tournaments, and localized competition events, LANtern facilitates secure exam running, roster control, and detailed score grading without dependency on external public cloud connectivity.

## Core Features

### 1. Student Test Runner
* Secure, focused testing interface mimicking robust assessment packages.
* Event-driven window focus checking that automatically detects and flags when students navigate away or switch tabs.
* Auto-saving client-side session state synchronized with the supervisor host.

### 2. Bento Grid Supervisor Dashboard
* Real-time desk activity and student session tracking.
* Visual indicators showing the live connection status of testing desks.
* Prominent, color-highlighted flags and counts for any student currently or previously leaving the exam window.

### 3. Exam Management and Regrading
* Interactive question suite supporting multiple choice and free-response formats.
* Dynamic multiple-choice regrading functionality. If an answer key correction is made after collecting student submissions, administrators can click a single button to immediately recalculate the multiple-choice scores across all completed responses.

### 4. Advanced Score Exports
* Specialized multi-test analytical CSV matrix export formatted for roster analysis.
* Exports structure:
  * Rows: Students sorted alphabetically by name.
  * Columns: Each test name is sorted alphabetically, structured with two adjacent columns per test — Multiple Choice score first, followed by the Free Response score.

## Setup and Development

### Prerequisites
* Node.js and npm installed.

### Installation
Install application dependencies:
```bash
npm install
```

### Running the Application
Start the development server:
```bash
npm run dev
```
The client and server will run synchronized locally, accessible via port 3000.
