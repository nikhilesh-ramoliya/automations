const glob = require('glob');
const fs = require('fs');

const emptySwaggerOptions = {
  swagger: '2.0',
  info: {
    title: 'Base Backend',
    version: '1.0',
  },
  host: process.env.BASE_URL || 'localhost:7000',
  basePath: '/api',
  schemes: ['http', 'https'],
};

/**
 * It will search for json file in features and combine swaggeroptions with paths
 * @returns swaggeroptions data
 */
const getSwaggerOptions = async () => {
  const featureSwaggerJsons = [];

  const allFiles = await new Promise((resolve) => {
    glob('src/features/**/*.json', (err, files) => {
      resolve(files);
    });
  });

  allFiles.forEach((file) => {
    const swaggerJson = fs.readFileSync(file);
    featureSwaggerJsons.push(JSON.parse(swaggerJson));
  });

  let paths = {};
  featureSwaggerJsons.forEach((json) => {
    paths = { ...paths, ...json.paths };
  });
  return {
    ...emptySwaggerOptions,
    paths,
  };
};

module.exports = {
  getSwaggerOptions,
};
