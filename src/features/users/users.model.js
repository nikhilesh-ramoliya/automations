const prisma = require("../../db");
const { hashPassword, isPasswordValid } = require("./users.service");
const signupUser = async (data, res) => {
  try {
    const { email, password, confirmPassword } = data;
    console.log({ email });
    const isEmailExist = await prisma.users.findFirst({ where: { email } });
    console.log({ isEmailExist });
    if (isEmailExist) {
      return {
        message: "Email already been used in another account.",
        status: 400,
      };
    }
    if (!(password === confirmPassword)) {
      return { message: "password and confirm does't match", status: 400 };
    }
    delete data.confirmPassword;
    delete data.password;
    const signupRes = await prisma.users.create({
      data,
    });
    const encryptPassword = await hashPassword(password, res);

    const passwordRes = await prisma.login.create({
      data: { usersId: signupRes.id, password: encryptPassword },
    });
    return { message: signupRes, status: 201 };
  } catch (err) {
    console.log({ err });
  }
};

const signinUser = async (data) => {
  try {
    const { email, password } = data;
    const userData = await prisma.users.findFirst({
      where: { email },
    });

    if (userData) {
      const loginData = await prisma.login.findFirst({
        where: { usersId: userData.id },
      });
      const isValid = await isPasswordValid(password, loginData.password);
      return { isValid, userData };
    }
    return { isValid: false };
  } catch (err) {
    console.log({ err });
  }
};

module.exports = { signupUser, signinUser };
