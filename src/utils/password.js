const bcryptjs = require("bcryptjs");

/**
 * It will hash password using bcryptjs package
 * @param {string} password user password
 * @returns hash password
 */
const hashPassword = (password) => {
  const passwordHash = bcryptjs.hash(password, 12);
  return passwordHash;
};

/**
 * It will check password correct or not by using user enter password and hash password
 * @param {string} loginPassword user enter password
 * @param {string} dbPassword  hash password
 * @returns true or false
 */
const isPasswordValid = (loginPassword, dbPassword) => {
  const isValid = bcryptjs.compare(loginPassword, dbPassword);
  return isValid;
};

module.exports = { hashPassword, isPasswordValid };
