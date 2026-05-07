beforeAll(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.MP_ACCESS_TOKEN = 'test-mp-token';
  process.env.FRONTEND_URL = 'http://localhost:3000';
});
