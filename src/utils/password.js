const bcryptjs = require('bcryptjs');

const hashPassword = (password) => {
  const passwordHash = bcryptjs.hash(password, 12);
  return passwordHash;
};

const isPasswordValid = (loginPassword, dbPassword) => {
  const isValid = bcryptjs.compare(loginPassword, dbPassword);
  return isValid;
};

module.exports = { hashPassword, isPasswordValid };
