// Use this function like this app.post("/api/signin", use(signin)) because express handler won't understand the promise is pending or resolved so have to wrap with this use().
const useErrorHandlingMiddleware = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ERROR_CODE = {
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER: 500,
};
module.exports = { useErrorHandlingMiddleware, ERROR_CODE };
