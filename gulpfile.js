// Credit to https://github.com/jensgrud/aws-lambda-opencv/


var http = require('http');
var fs = require('fs');
var gulp = require('gulp');
var gutil = require('gulp-util');
var shell = require('gulp-shell');
var flatten = require('gulp-flatten');
var rename = require('gulp-rename');
var del = require('del');
var install = require('gulp-install');
var zip = require('gulp-zip');
var AWS = require('aws-sdk');
var runSequence = require('run-sequence');
var async = require('async');
var s3 = new AWS.S3();


var build = './build';
var filename = '2.4.12.3';
var fileURL = 'http://github.com/Itseez/opencv/archive';
var extension = 'zip';

gulp.task('download-opencv', shell.task([
	' wget ' + fileURL + '/' + filename + '.' + extension 
]));

gulp.task('unzip-opencv', shell.task([
	'unzip ' + filename + '.' + extension + ' -d ' + build
]));

gulp.task('cmake-opencv', shell.task([
	'cd ' + build + '; cmake -D BUILD_PNG=OFF -D CMAKE_BUILD_TYPE=RELEASE -D BUILD_SHARED_LIBS=NO -D CMAKE_INSTALL_PREFIX=./opencv opencv-' + filename + '/'
]));

gulp.task('make-opencv', shell.task([
	'cd ' + build + '; make && make install'
]));

// Change path if needed - needs to be full
gulp.task('npm-opencv', shell.task([
	'cd ./build; PKG_CONFIG_PATH=' + process.cwd() + '/build/opencv/lib/pkgconfig/ npm install opencv'
]));

gulp.task('copy-opencv', function() {
	return gulp.src(['./node_modules/opencv/**/*'])
		.pipe(gulp.dest('./dist/node_modules/opencv'));
});

// First we need to clean out the dist folder and remove the compiled zip file.
gulp.task('clean', function(cb) {
	del([
		'./build/*',
		'./dist/*',
		'./dist.zip'
	], cb);
});

gulp.task('src', function() {
    return gulp.src(['ocr-tesseract.js','config', 'tesseract', 'wordlist', 'userpatterns'])
		.pipe(gulp.dest('./dist'))
});

gulp.task('sanitizers', function() {
    return gulp.src(['sanitizers/*',  'tessdata/*'])
		.pipe(gulp.dest('./dist/sanitizers/'))
});

gulp.task('tessdata', function() {
    return gulp.src(['tessdata/*'])
		.pipe(gulp.dest('./dist/tessdata/'))
});

gulp.task('lib', function() {
	return gulp.src(['lib/*'])
		.pipe(gulp.dest('./dist/lib/'))
});

// Here we want to install npm packages to dist, ignoring devDependencies.
gulp.task('npm', function() {
	return gulp.src('./package.json')
		.pipe(gulp.dest('./dist'))
		.pipe(install({production: true}));
});

// Now the dist directory is ready to go. Zip it.
gulp.task('zip', function() {
	return gulp.src(['dist/**/*', '!dist/package.json', 'dist/.*'])
		.pipe(zip('dist.zip'))
		.pipe(gulp.dest('./'));
});


gulp.task('default', function(cb) {
	return runSequence(
//		['clean'],
//		['download-opencv'],
//		['unzip-opencv'],
//		['cmake-opencv'],
//		['make-opencv'],
//		['npm-opencv'],
		['copy-opencv'],
		['src', 'lib', 'tessdata', 'sanitizers', 'npm'],
		['zip'],
		cb
	);
});
