'use strict';

/**
 * @fileoverview tanvir143 - Authentication API
 * @author tanvir143 (Tanvir Ahmed)
 * @copyright 2026 tanvir143
 * @license MIT
 * @module Auth
 * @since 1.1.2
 */

const EventEmitter = require('events');
const CryptoUtils = require('../utils/crypto');
const ValidationUtils = require('../utils/validation');
const { nkxicaLog: log } = require('../utils/logger');

/**
 * Safely extract and validate a numeric Instagram user ID from an API response
 * user object. Returns the validated id as a string, or null if neither
 * candidate field looks like a valid user ID.
 */
function extractUserId(user) {
  if (!user || typeof user !== 'object') return null;
  const candidates = [user.pk_id, user.pk, user.user_id, user.id];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const s = c.toString();
    if (ValidationUtils.isValidUserID(s)) return s;
  }
  return null;
}

class Auth extends EventEmitter {
  constructor(httpClient, options = {}) {
    super();
    this.http = httpClient;
    this.username = options.username;
    this.password = options.password;
    this.deviceId = options.deviceId;
    this.phoneId = options.phoneId;
    this.uuid = options.uuid;
    this.advertisingId = options.advertisingId;
    this.authenticated = false;
    this.userId = null;
  }

  // Login with cookies (no username/password required)
  async loginWithCookies(cookies, options = {}, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    try {
      log.info('Logging in with cookies...');

      if (!cookies) {
        throw new Error('Cookies cannot be empty or undefined');
      }

      // Parse and load cookies
      const CookieUtils = require('../utils/cookies');
      const parsedJar = CookieUtils.parse(cookies);
      
      // Replace HTTP client's jar with parsed jar
      this.http.jar = parsedJar;
      if (this.http.client && this.http.client.defaults) {
        this.http.client.defaults.jar = parsedJar;
      }
      
      // Get cookies list for verification
      const cookiesList = parsedJar.serializeSync ? parsedJar.serializeSync().cookies : [];
      log.verbose(`Parsed cookies count: ${cookiesList.length}`);

      // Try to extract user info from cookies
      const sessionCookie = cookiesList.find(c => c.key === 'sessionid');
      const dsUserId = cookiesList.find(c => c.key === 'ds_user_id');
      const wdCookie = cookiesList.find(c => c.key === 'wd');  // Viewport dimensions
      
      if (!sessionCookie) {
        throw new Error('No sessionid cookie found. Cookies may be invalid or expired.');
      }

      // Set browser session data if available
      if (wdCookie && wdCookie.value) {
        const dimensions = wdCookie.value.split('x');
        this.http.viewportWidth = parseInt(dimensions[0]) || 468;
        this.http.viewportHeight = parseInt(dimensions[1]) || 905;
      }
      
      let userId = options.userId;
      let username = options.username;

      if (dsUserId && dsUserId.value) {
        userId = dsUserId.value;
      }

      // Try to get current user info to verify session securely
      try {
        const rawResponse = await this.http.get('https://www.instagram.com/api/v1/accounts/current_user/');
        const userInfoResponse = rawResponse?.data || rawResponse;

        if (userInfoResponse && userInfoResponse.user) {
          const extracted = extractUserId(userInfoResponse.user);
          if (!extracted) {
            throw new Error('Login response contained an invalid user ID');
          }
          this.userId = extracted;
          this.username = userInfoResponse.user.username || username || 'Unknown';
          this.authenticated = true;
          
          if (userInfoResponse.authorization) {
            this.http.setAuthorization(userInfoResponse.authorization);
          }
          
          log.info(`Successfully logged in as ${this.username}`);
          
          const result = {
            success: true,
            userID: this.userId,
            userId: this.userId,
            username: this.username,
            fullName: userInfoResponse.user.full_name || '',
            profilePicUrl: userInfoResponse.user.profile_pic_url || '',
            isVerified: !!userInfoResponse.user.is_verified,
            isPrivate: !!userInfoResponse.user.is_private,
            authorization: this.http.authorization
          };
          
          if (callback) return callback(null, result);
          return result;
        }
      } catch (verifyError) {
        // Fallback: If network check fails but we have ds_user_id, allow wrapper to pass
        if (userId) {
          const fallbackId = userId.toString();
          if (ValidationUtils.isValidUserID(fallbackId)) {
            this.userId = fallbackId;
            this.username = username || 'Unknown';
            this.authenticated = true;
            
            log.warn('Could not verify session via network, but fallback ds_user_id is present.');
            
            const result = {
              success: true,
              userID: this.userId,
              userId: this.userId,
              username: this.username,
              fullName: '',
              profilePicUrl: '',
              isVerified: false,
              isPrivate: false,
              authorization: this.http.authorization,
              warning: 'Session verification failed, but fallback cookie ID was loaded'
            };
            
            if (callback) return callback(null, result);
            return result;
          }
        }
        
        throw new Error(verifyError?.message || 'Failed to verify session with cookies. Cookies may be expired or invalid.');
      }

      throw new Error('Could not verify session with cookies: Invalid user response payload');
    } catch (error) {
      const errorMsg = error?.message || (typeof error === 'string' ? error : 'Unknown error during cookie login');
      log.error('Cookie login failed:', errorMsg);
      const finalError = error instanceof Error ? error : new Error(errorMsg);
      if (callback) return callback(finalError);
      throw finalError;
    }
  }

  // Login with credentials
  async login(username, password, callback) {
    if (username) this.username = username;
    if (password) this.password = password;

    if (!this.username || !this.password) {
      const error = new Error('Username and password are required');
      if (callback) return callback(error);
      throw error;
    }

    try {
      log.info(`Logging in as ${this.username}...`);

      const loginData = {
        phone_id: this.phoneId,
        username: this.username,
        password: this.password,
        guid: this.uuid,
        device_id: this.deviceId,
        adid: this.advertisingId,
        google_tokens: '[]',
        login_attempt_count: 0,
        country_codes: JSON.stringify([{ country_code: '1', source: 'default' }]),
        source: 'login',
        jazoest: CryptoUtils.generateJazoest()
      };

      const signature = CryptoUtils.generateSignature(JSON.stringify(loginData));

      const rawResponse = await this.http.post(
        'https://www.instagram.com/api/v1/accounts/login/',
        signature,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
          }
        }
      );

      const response = rawResponse?.data || rawResponse;

      if (!response) {
        throw new Error('Empty response received from Instagram login endpoint');
      }

      if (response.status === 'ok') {
        const extracted = extractUserId(response.logged_in_user);
        if (!extracted) {
          throw new Error('Login response contained an invalid user ID');
        }
        this.authenticated = true;
        this.userId = extracted;
        this.http.setAuthorization(response.authorization || '');

        log.info(`Successfully logged in as ${response.logged_in_user?.username || this.username}`);
        
        const result = {
          success: true,
          userID: this.userId,
          userId: this.userId,
          username: response.logged_in_user?.username || this.username,
          fullName: response.logged_in_user?.full_name || '',
          profilePicUrl: response.logged_in_user?.profile_pic_url || '',
          isVerified: !!response.logged_in_user?.is_verified,
          isPrivate: !!response.logged_in_user?.is_private
        };
        
        if (callback) return callback(null, result);
        return result;
      }
      
      if (response.two_factor_required) {
        log.info('Two-factor authentication required');
        
        const result = {
          success: false,
          twoFactorRequired: true,
          twoFactorIdentifier: response.two_factor_info?.two_factor_identifier,
          phoneNumberHint: response.two_factor_info?.obfuscated_phone_number
        };
        
        if (callback) return callback(null, result);
        return result;
      }

      if (response.checkpoint_url) {
        log.warn('Challenge required');
        
        const result = {
          success: false,
          challengeRequired: true,
          checkpointUrl: response.checkpoint_url,
          lock: response.lock
        };
        
        if (callback) return callback(null, result);
        return result;
      }

      throw new Error(response.message || 'Login failed');
    } catch (error) {
      const errorMsg = error?.message || (typeof error === 'string' ? error : 'Unknown error during login');
      log.error('Login failed:', errorMsg);
      const finalError = error instanceof Error ? error : new Error(errorMsg);
      if (callback) return callback(finalError);
      throw finalError;
    }
  }

  // Verify two-factor authentication
  async verifyTwoFactor(code, twoFactorIdentifier, callback) {
    try {
      log.info('Verifying 2FA code...');

      const verifyData = {
        verification_code: code,
        phone_id: this.phoneId,
        two_factor_identifier: twoFactorIdentifier,
        username: this.username,
        trust_this_device: 1,
        guid: this.uuid,
        device_id: this.deviceId,
        adid: this.advertisingId,
        google_tokens: '[]',
        login_attempt_count: 0
      };

      const signature = CryptoUtils.generateSignature(JSON.stringify(verifyData));

      const rawResponse = await this.http.post(
        'https://www.instagram.com/api/v1/accounts/two_factor_login/',
        signature,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
          }
        }
      );

      const response = rawResponse?.data || rawResponse;

      if (!response) {
        throw new Error('Empty response received from 2FA endpoint');
      }

      if (response.status === 'ok') {
        const extracted = extractUserId(response.logged_in_user);
        if (!extracted) {
          throw new Error('2FA response contained an invalid user ID');
        }
        this.authenticated = true;
        this.userId = extracted;
        this.http.setAuthorization(response.authorization || '');

        log.info('2FA verification successful');
        
        const result = {
          success: true,
          userID: this.userId,
          userId: this.userId,
          username: response.logged_in_user?.username || this.username,
          fullName: response.logged_in_user?.full_name || ''
        };
        
        if (callback) return callback(null, result);
        return result;
      }

      throw new Error(response.message || 'Two-factor verification failed');
    } catch (error) {
      const errorMsg = error?.message || (typeof error === 'string' ? error : 'Unknown error during 2FA');
      log.error('2FA verification failed:', errorMsg);
      const finalError = error instanceof Error ? error : new Error(errorMsg);
      if (callback) return callback(finalError);
      throw finalError;
    }
  }

  // Logout
  async logout(callback) {
    try {
      const data = {
        guid: this.uuid,
        phone_id: this.phoneId,
        _csrftoken: this.http.getCsrfToken ? (this.http.getCsrfToken() || 'missing') : 'missing'
      };

      const signature = CryptoUtils.generateSignature(JSON.stringify(data));

      await this.http.post(
        'https://www.instagram.com/api/v1/accounts/logout/',
        signature,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
          }
        }
      ).catch(() => {});

      log.info('Logged out');
    } catch (error) {
      // Ignore errors
    }

    this.authenticated = false;
    this.userId = null;
    if (this.http.clearSession) {
      this.http.clearSession();
    }
    
    const result = { success: true };
    if (callback) return callback(null, result);
    return result;
  }

  getSession() {
    return {
      username: this.username,
      userId: this.userId,
      authenticated: this.authenticated,
      deviceId: this.deviceId,
      phoneId: this.phoneId,
      uuid: this.uuid,
      advertisingId: this.advertisingId,
      httpSession: this.http.getSession ? this.http.getSession() : null
    };
  }

  async loadSession(sessionData) {
    if (!sessionData) return;
    this.username = sessionData.username;
    this.userId = sessionData.userId?.toString() ?? null;
    this.authenticated = !!sessionData.authenticated;
    this.deviceId = sessionData.deviceId;
    this.phoneId = sessionData.phoneId;
    this.uuid = sessionData.uuid;
    this.advertisingId = sessionData.advertisingId;
    
    if (sessionData.httpSession && this.http.loadSession) {
      await this.http.loadSession(sessionData.httpSession);
    }

    log.info('Session loaded');
  }

  isAuthenticated() {
    return this.authenticated && this.userId !== null;
  }

  getCurrentUserID() {
    return {
      userID: this.userId,
      userId: this.userId
    };
  }
}

module.exports = Auth;
