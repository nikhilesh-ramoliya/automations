const jwt = require("jsonwebtoken");

const generateToken = (data) => {
  return jwt.sign(data, process.env.JWT_TOKEN_SECRET, {
    expiresIn: "1d",
  });
};

const verifyToken = (token) => {
  const resJwt = jwt.verify(token, process.env.JWT_TOKEN_SECRET);
  if (resJwt) {
    return resJwt;
  } else {
    return false;
  }
};

module.exports = {
  generateToken,
  verifyToken,
};
