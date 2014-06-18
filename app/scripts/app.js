define(
	[
		'jquery',
		'isotope',
		'packery',
		'get-size'
	], 

	function($, Isotope, Packery, getSize) {
		console.log('jQuery %s', $().jquery);
		console.log('isotope', Isotope);
		console.log('Packery', Packery);


		// overwrite Packery methods
		var __resetLayout = Packery.prototype._resetLayout;
		Packery.prototype._resetLayout = function() {
		  __resetLayout.call( this );
		  // reset packer
		  var parentSize = getSize( this.element.parentNode );
		  var colW = this.columnWidth + this.gutter;
		  this.fitWidth = Math.floor( ( parentSize.innerWidth + this.gutter ) / colW ) * colW;
		  console.log( colW, this.fitWidth )
		  this.packer.width = this.fitWidth;
		  this.packer.height = Number.POSITIVE_INFINITY;
		  this.packer.reset();
		};


		Packery.prototype._getContainerSize = function() {
		  // remove empty space from fit width
		  var emptyWidth = 0;
		  for ( var i=0, len = this.packer.spaces.length; i < len; i++ ) {
		    var space = this.packer.spaces[i];
		    if ( space.y === 0 && space.height === Number.POSITIVE_INFINITY ) {
		      emptyWidth += space.width;
		    }
		  }

		  return {
		    width: this.fitWidth - this.gutter,
		    height: this.maxY - this.gutter
		  };
		};

		// always resize
		Packery.prototype.resize = function() {
		  this.layout();
		};

		 var container = document.querySelector('#container');
		  var pckry = new Packery( container, {
		    itemSelector: '.element',
		    columnWidth: 120,
		    gutter: 10
		  });

		/*jquery

		var $container = $('#container').packery({
		    itemSelector: '.element',
		    columnWidth: 150,
		    gutter: 20
		  });*/

		/*var container = $('#container')[0];
		var iso = window.iso = new Isotope( container, {
			layoutMode: 'fitRows',
			masonry: {
			      columnWidth: 50
			    },
			layoutMode: 'packery',
			//itemSelector: '.mini-item',
			//stamp: '.stamp'
			getSortData: {
			  // number: function( itemElem ) {
			  //   return parseInt( getText( itemElem.querySelector('.number') ), 10 );
			  // },
			  // symbol: function( itemElem ) {
			  //   return getText( itemElem.querySelector('.symbol') );
			  // },
			  // name: function( itemElem ) {
			  //   return getText( itemElem.querySelector('.name') );
			  // },
			  // category: function( itemElem ) {
			  //   return itemElem.getAttribute('data-category');
			  // },
			  

			  number: '.number parseInt',
			  symbol: '.symbol',
			  name: '.name',
			  category: '[data-category]',

			  
			  }
			}
		});

		//var options = document.querySelector('#options');


		$('#options li a').click(function(event){
			//});
			//eventie.bind( options, 'click', function( event ) {
			// use link's href, remove leading hash
			var sortBy = event.target.getAttribute('href').slice( 1 );
			sortBy.slice( 0, 1 );
			iso.options.sortBy = sortBy;
			//window.console.log(iso, sortBy, event.target.getAttribute('href'));
			iso.arrange();
			event.preventDefault();
		});

		function getText( elem ) {
		  return elem.textContent || elem.innerText;
		}*/

		$(".element").click(function(e){
			window.console.log($(this));
		});




	}
);