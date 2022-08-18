const bcryptjs = require("bcryptjs");

const hashPassword = async (password, res) => {
  try {
    const passwordHash = await bcryptjs.hash(password, 12);
    return passwordHash;
  } catch (err) {
    console.log({ err });
    res.status(500).json({ error: "Internal Error" });
  }
};

const isPasswordValid = async (loginPassword, dbPassword) => {
  try {
    const isValid = await bcryptjs.compare(loginPassword, dbPassword);
    return isValid;
  } catch (err) {
    console.log({ err });
  }
};

module.exports = { hashPassword, isPasswordValid };
