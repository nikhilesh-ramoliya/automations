const jwt = require('jsonwebtoken');

/**
 * It will generate token for data using secret key
 * @param {object} data user data
 * @returns sign token
 */
const generateToken = (data) =>
  jwt.sign(data, process.env.JWT_TOKEN_SECRET, {
    expiresIn: '1d',
  });

/**
 * It will verify  whether token valid or not
 * @param {string} token jwt generated token
 * @returns data or false
 */
const verifyToken = (token) => {
  const resJwt = jwt.verify(token, process.env.JWT_TOKEN_SECRET);
  if (resJwt) {
    return resJwt;
  }
  return false;
};

module.exports = {
  generateToken,
  verifyToken,
};
