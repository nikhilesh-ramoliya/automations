const {
  ValidationError,
  EmailExistError,
  InvalidDetailsError,
  UserExistError,
} = require("../error");

// Use this function like this app.post("/api/signin", useErrorHandlingMiddleware(signin)) because express handler won't understand the promise is pending or resolved so have to wrap with this useErrorHandlingMiddleware().
const useErrorHandlingMiddleware = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
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

const ERROR_CODE = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER: 500,
};
module.exports = { useErrorHandlingMiddleware, ERROR_CODE };
