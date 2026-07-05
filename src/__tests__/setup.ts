beforeAll(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.MP_ACCESS_TOKEN = 'test-mp-token';
  process.env.MP_CLIENT_ID = 'test-mp-client-id';
  process.env.MP_CLIENT_SECRET = 'test-mp-client-secret';
  process.env.MP_OAUTH_REDIRECT_URI = 'http://localhost:4000/api/mercadopago/oauth/callback';
  process.env.FRONTEND_URL = 'http://localhost:3000';
});
