const { verifyToken } = require("../utils/jwt-utils");

const authenticate = async (token) => {
  try {
    const tokenData = await verifyToken(token);
    if (tokenData) {
      return tokenData;
    } else {
      return false;
    }
  } catch (err) {
    console.log({ err });
    return false;
  }
};

const validateUserToken = async (req, res, next) => {
  try {
    const token = req.cookies.jwtToken;
    const data = await authenticate(token);
    if (data) {
      req.user = data;
    } else {
      console.log("user does't exist");
      res.status(400).json({ message: "user does not exist" });
    }
    next();
  } catch (err) {
    console.log({ err });
  }
};

module.exports = { validateUserToken };
