const {
  ValidationError,
  EmailExistError,
  InvalidDetailsError,
} = require("../../error");
const { hashPassword, isPasswordValid } = require("../../utils/password");
const {
  isUserEmailExist,
  createUser,
  setUserPassword,
  isUserExistLogin,
} = require("./users.service");
const prisma = require("../../db");

const signupUser = async (data) => {
  const { email, password, confirmPassword } = data;
  const isEmailExist = await isUserEmailExist(email);
  if (isEmailExist) {
    throw new EmailExistError("Email already been used in another account.");
  }
  if (!(password === confirmPassword)) {
    throw new ValidationError("password and cofirm password does't match");
  }
  delete data.confirmPassword;
  delete data.password;
  const signupRes = await createUser(data);
  const encryptPassword = await hashPassword(password);
  await setUserPassword(signupRes.id, encryptPassword);

  return signupRes;
};

const signinUser = async (data) => {
  const { email, password } = data;
  const userData = await isUserEmailExist(email);

  if (!userData) {
    throw new InvalidDetailsError("Invalid Details");
  }

  const loginData = await isUserExistLogin(userData.id);
  const isValid = await isPasswordValid(password, loginData.password);
  if (!isValid) {
    throw new InvalidDetailsError("Invalid Details");
  }
  return userData;
};

module.exports = { signupUser, signinUser };
