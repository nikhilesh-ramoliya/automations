const {
  ValidationError,
  EmailExistError,
  InvalidDetailsError,
  UserExistError,
} = require('../error');

const ERROR_CODE = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER: 500,
};
/**
 * It will handle all errors and send response with appropiate message to client
 * @param {function} fn To handle error
 * @returns pass control to next function
 *
 */
const useErrorHandlingMiddleware = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.log({ err });
    if (err instanceof ValidationError) {
      res.status(ERROR_CODE.NOT_FOUND).json({ error: err.message });
    } else if (err instanceof EmailExistError) {
      res.status(ERROR_CODE.BAD_REQUEST).json({ error: err.message });
    } else if (err instanceof InvalidDetailsError) {
      res.status(ERROR_CODE.BAD_REQUEST).json({ error: err.message });
    } else if (err instanceof UserExistError) {
      res.status(ERROR_CODE.NOT_FOUND).json({ error: err.message });
    } else {
      res.status(ERROR_CODE.INTERNAL_SERVER).json({ error: err.message });
    }
    next(err);
  });

module.exports = { useErrorHandlingMiddleware, ERROR_CODE };
