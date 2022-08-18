const jwt = require("jsonwebtoken");

const generateToken = (data) => {
  return jwt.sign(data, process.env.JWT_TOKEN_SECRET, {
    expiresIn: "1d",
  });
};

const verifyToken = (token) => {
  try {
    const resJwt = jwt.verify(token, process.env.JWT_TOKEN_SECRET);
    if (resJwt) {
      return resJwt;
    } else {
      return false;
    }
  } catch (err) {
    console.log(err);
  }
};

module.exports = {
  generateToken,
  verifyToken,
};
