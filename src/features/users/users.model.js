const prisma = require("../../db");

const isUserEmailExist = async (email) => {
  return await prisma.users.findFirst({ where: { email } });
};

const createUser = async (data) => {
  return await prisma.users.create({
    data,
  });
};

const setUserPassword = async (usersId, password) => {
  return await prisma.login.create({
    data: { usersId, password },
  });
};

const isUserExistLogin = async (usersId) => {
  return await prisma.login.findFirst({
    where: { usersId },
  });
};

module.exports = {
  isUserEmailExist,
  createUser,
  setUserPassword,
  isUserExistLogin,
};
