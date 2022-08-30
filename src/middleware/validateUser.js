const { verifyToken } = require('../utils/jwt-utils');
const { UserExistError } = require('../error');

const authenticate = async (token) => {
  const tokenData = await verifyToken(token);
  if (tokenData) {
    return tokenData;
  }
  return false;
};

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
