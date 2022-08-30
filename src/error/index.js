/* eslint-disable max-classes-per-file */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class EmailExistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmailExistError';
  }
}

class InvalidDetailsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDetailsError';
  }
}

class UserExistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserExistError';
  }
}

class EmailSendError extends Error {
  constructor(message) {
    super(message);
    this.name = EmailSendError;
  }
}

module.exports = {
  ValidationError,
  EmailExistError,
  InvalidDetailsError,
  UserExistError,
  EmailSendError,
};
