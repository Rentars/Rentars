import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { errorMiddleware } from './middleware/error.middleware';
import { rateLimiter } from './middleware/rateLimiter';
import authRoutes from './routes/auth.routes';
import bookingRoutes from './routes/booking.routes';
import locationRoutes from './routes/location.routes';
import profileRoutes from './routes/profile.route';
import propertyRoutes from './routes/property.routes';
import syncRoutes from './routes/sync.routes';
import { startSyncScheduler } from './services/cleanup-schedular';

dotenv.config();

export const app = express();

app.use(express.json());
app.use(
  cors({
    origin: [process.env.CORS_ORIGIN || 'http://localhost:3001'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(rateLimiter);

// Routes
app.use('/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/sync', syncRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Rentars API 🚀' });
});

app.use(errorMiddleware);

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`🚀 Rentars API running on http://localhost:${PORT}`);
  startSyncScheduler();
});
