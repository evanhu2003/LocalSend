import 'package:flutter/material.dart';
import 'package:localsend_app/widget/responsive_builder.dart';
import 'package:routerino/routerino.dart';

class CustomBottomSheet extends StatelessWidget {
  final String title;
  final String? description;
  final Widget child;
  const CustomBottomSheet({
    required this.title,
    required this.description,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    // Scrollable so that the sheet never overflows when it is taller than the space the modal route allows
    // (e.g. on tiny smartwatch screens). When the content fits, this is layout-identical to no scroll view.
    return SingleChildScrollView(
      child: RouterinoBottomSheet(
        title: title,
        description: description,
        backgroundColor: Theme.of(context).scaffoldBackgroundColor,
        borderRadius: 20,
        padding: SizingInformation.isCompactScreen(context) ? const EdgeInsets.all(12) : const EdgeInsets.all(20),
        child: child,
      ),
    );
  }
}
