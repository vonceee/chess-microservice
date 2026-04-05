// Configuration for chess microservice
const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 3006,
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:8000',
  BUFFER_SECONDS: 5,
};

module.exports = config;