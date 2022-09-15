const {
  ValidationError,
  EmailExistError,
  InvalidDetailsError,
} = require('../../error');
const { hashPassword, isPasswordValid } = require('../../utils/password');
const {
  isUserEmailExist,
  createUser,
  setUserPassword,
  isUserExistLogin,
} = require('./users.model');
const { generateToken } = require('../../utils/jwt-utils');

const signupUser = async (data) => {
  const { email, password, confirmPassword } = data;
  const { existingUser } = await isUserEmailExist(email);

  if (existingUser) {
    throw new EmailExistError('Email already been used in another account.');
  }
  if (!(password === confirmPassword)) {
    throw new ValidationError("password and cofirm password does't match");
  }
  // eslint-disable-next-line no-param-reassign
  delete data.confirmPassword;
  // eslint-disable-next-line no-param-reassign
  delete data.password;
  const { newUser } = await createUser(data);
  const encryptPassword = await hashPassword(password);
  await setUserPassword(newUser.id, encryptPassword);

  return { newUser };
};

const signinUser = async (data) => {
  const { email, password } = data;
  const userData = await isUserEmailExist(email);

  if (!userData) {
    throw new InvalidDetailsError('Invalid Details');
  }

  const loginData = await isUserExistLogin(userData.existingUser.id);

  const isValid = await isPasswordValid(password, loginData.password);
  if (!isValid) {
    throw new InvalidDetailsError('Invalid Details');
  }
  const token = await generateToken(userData.existingUser);
  return { token };
};

module.exports = { signupUser, signinUser };
