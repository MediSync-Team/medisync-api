import { describe, it, expect } from '@jest/globals';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

describe('Auth Utils', () => {
  describe('Password hashing', () => {
    it('should hash password with bcrypt', async () => {
      const password = 'testPassword123';
      const hashedPassword = await bcrypt.hash(password, 10);
      
      expect(hashedPassword).not.toBe(password);
      expect(hashedPassword.length).toBeGreaterThan(20);
      expect(hashedPassword.startsWith('$2')).toBe(true);
    });

    it('should verify correct password', async () => {
      const password = 'testPassword123';
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const isValid = await bcrypt.compare(password, hashedPassword);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const password = 'testPassword123';
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const isValid = await bcrypt.compare('wrongPassword', hashedPassword);
      expect(isValid).toBe(false);
    });
  });

  describe('JWT tokens', () => {
    it('should generate valid JWT token', () => {
      const token = jwt.sign(
        { userId: 'test-id', rol: 'PROFESIONAL' },
        'test-jwt-secret',
        { expiresIn: '7d' }
      );
      
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.').length).toBe(3);
    });

    it('should verify and decode token', () => {
      const token = jwt.sign(
        { userId: 'test-id', rol: 'PACIENTE' },
        'test-jwt-secret',
        { expiresIn: '7d' }
      );
      
      const decoded = jwt.verify(token, 'test-jwt-secret') as any;
      expect(decoded.userId).toBe('test-id');
      expect(decoded.rol).toBe('PACIENTE');
    });

    it('should reject invalid token', () => {
      expect(() => {
        jwt.verify('invalid-token', 'test-jwt-secret');
      }).toThrow();
    });

    it('should reject token with wrong secret', () => {
      const token = jwt.sign({ userId: 'test' }, 'secret1');
      
      expect(() => {
        jwt.verify(token, 'secret2');
      }).toThrow();
    });
  });

  describe('Password validation', () => {
    it('should validate strong passwords', () => {
      const isValidPassword = (password: string) => {
        return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/.test(password);
      };

      expect(isValidPassword('Password123!')).toBe(true);
      expect(isValidPassword('Password123')).toBe(false);
      expect(isValidPassword('password123!')).toBe(false);
      expect(isValidPassword('PASSWORD123!')).toBe(false);
      expect(isValidPassword('Password!')).toBe(false);
      expect(isValidPassword('Pas123!')).toBe(false);
      expect(isValidPassword('')).toBe(false);
    });
  });
});
