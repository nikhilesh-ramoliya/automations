const prisma = require('../../db');

const isUserEmailExist = async (email) => {
  const existingUser = await prisma.users.findFirst({ where: { email } });
  return { existingUser };
};

const createUser = async (data) => {
  const newUser = await prisma.users.create({
    data,
  });
  return { newUser };
};

const setUserPassword = async (usersId, password) => {
  const userPassword = await prisma.login.create({
    data: { usersId, password },
  });
  return { userPassword };
};

const isUserExistLogin = async (usersId) => {
  const existingUser = await prisma.login.findFirst({
    where: { usersId },
  });
  return existingUser;
};

module.exports = {
  isUserEmailExist,
  createUser,
  setUserPassword,
  isUserExistLogin,
};
