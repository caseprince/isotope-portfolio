require.config({
	baseUrl: 'scripts',
    paths: {
        jquery: '../bower_components/jquery/jquery',
        isotope: '../bower_components/isotope/dist/isotope.pkgd',
        //packery: '../bower_components/isotope-packery/packery-mode.pkgd',
        packery: '../bower_components/packery/dist/packery.pkgd',
        'get-size': '../bower_components/get-size/get-size',
        'get-style-property': '../bower_components/get-style-property',
	},
	shim: {
		'isotope': ['jquery'],
		//'packery': ['isotope']
	}
});

// Load the main app module to start the app
requirejs(["app"]);

/*require(['app', 'jquery'], function (app, $) {
    'use strict';
    // use app here
    console.log(app);
    console.log('Running jQuery %s', $().jquery);
});*/
