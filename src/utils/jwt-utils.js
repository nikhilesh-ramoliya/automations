const jwt = require('jsonwebtoken');

const generateToken = (data) =>
  jwt.sign(data, process.env.JWT_TOKEN_SECRET, {
    expiresIn: '1d',
  });

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
