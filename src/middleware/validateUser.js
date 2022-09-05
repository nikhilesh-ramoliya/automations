const { verifyToken } = require('../utils/jwt-utils');
const { UserExistError } = require('../error');

/**
 * It will check whether token valid or not
 * @param {string} token jwt generated token
 * @returns tokendata or false
 */
const authenticate = async (token) => {
  const tokenData = await verifyToken(token);
  if (tokenData) {
    return tokenData;
  }
  return false;
};

/**
 * It will validate token and set user data in request
 * @param {object} req request object
 * @param {object} res response object
 * @param {function} next pass control to next function
 */
const validateUserToken = async (req, res, next) => {
  const token = req.cookies.jwtToken;
  const data = await authenticate(token);
  if (data) {
    req.user = data;
  } else {
    throw new UserExistError("User Does't Exist");
  }
  next();
};

module.exports = { validateUserToken };
