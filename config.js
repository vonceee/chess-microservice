// Configuration for chess microservice
const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3006,
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:8000',
  INTERNAL_SECRET: process.env.INTERNAL_SECRET || 'v0n_ch3ss_s3cr3t_2026',
  BUFFER_SECONDS: 5,
};

module.exports = config;