// Vercel serverless entry point.
// Every request under /api/* is rewritten here (see vercel.json) and handled by
// the Express application. The app is created once per warm instance and the
// MongoDB connection is cached on globalThis (see server/src/db/connect.js).
import { getApp } from '../server/src/app.js';

export default function handler(req, res) {
  return getApp()(req, res);
}
